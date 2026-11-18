/**
 * PrivateMode AI provider extension.
 *
 * Registers PrivateMode AI (https://privatemode.ai) as an OpenAI-compatible
 * provider. PrivateMode is end-to-end encrypted via confidential computing; it
 * requires a local proxy (podman container) that does client-side encryption +
 * remote attestation before anything leaves your machine. This extension
 * auto-starts that proxy on demand and reuses a running instance across pi
 * sessions.
 *
 * Container runtime: **podman** (not docker). podman is rootless and is the
 * fleet standard (provisioned via myrig).
 *
 * Dynamic host port: the proxy listens on 8080 *inside* the container, but the
 * HOST-side published port is auto-assigned (`-p 127.0.0.1::8080`) and
 * discovered at runtime via `podman port`. This avoids collisions with other
 * local servers (e.g. an mlx_lm.server bound to :8080) — we never assume 8080
 * on the host. The base URL is built from the discovered port each session.
 *
 * Keyless proxy: v1.64.0 is started WITHOUT `--api-key`, so the proxy forwards
 * the client's Authorization header to Privatemode. pi holds
 * $PRIVATEMODE_API_KEY and authenticates per request — the key never lives in
 * podman args, and key rotation needs no proxy restart. The image is pinned by
 * digest because upstream has announced a future release that will require an
 * attestation key at proxy startup; do not advance the pin past v1.64.0 without
 * first adopting a mounted secret plus `--api-key-fallback=never`.
 *
 * Cross-session reuse: every pi session looks up the existing
 * `privatemode-proxy` container, reads its published port via `podman port`,
 * and reuses it. Only the first session creates the container. The container
 * runs with `--restart unless-stopped`, so it survives pi crashes and (on
 * Linux) reboots; stop it deliberately with `podman stop privatemode-proxy`.
 * Existing containers are never pulled or replaced during startup. Use the
 * explicit `/privatemode update` command to upgrade an old proxy safely.
 *
 * Non-blocking startup: extension loading performs local podman/container setup
 * only. It registers a small current model seed immediately and uses Pi's
 * `refreshModels` lifecycle for remote `/v1/models` discovery. Pi calls that
 * lifecycle cache-only during startup, so an expired key or unavailable remote
 * service cannot hold every Pi launch for the proxy's retry window. Opening the
 * model picker performs the cancellable network refresh and persists its catalog.
 *
 * Shared local rate limiting: every Pi/mypi process on the machine reserves an
 * estimated prompt-token budget in one cache file before sending a chat request.
 * A sliding-window queue waits cancellably below PrivateMode's cached-prompt limit
 * instead of letting several large contexts trigger futile 2/4/8-second retries.
 * An unexpected upstream 429 installs a full-window cooldown before Pi's automatic
 * retry. Only timestamps and token estimates are stored; prompt and response content
 * is never written. The limiter is machine-local, so simultaneous traffic from another
 * machine can still cause the first upstream attempt to be rate-limited.
 *
 * Non-fatal load: if local setup fails (no podman, proxy cannot start, missing
 * key) this extension NEVER throws — throwing aborts pi startup entirely. It
 * warns loudly (console + an interactive `session_start` notification) and
 * registers nothing, so pi continues with its other providers.
 *
 * `/privatemode`            — show proxy, image, and model status
 * `/privatemode logs`       — tail proxy container logs
 * `/privatemode restart`    — restart the current proxy container
 * `/privatemode update`     — install the pinned proxy image and reload Pi
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  RATE_LIMIT_CACHED_TOKEN_BUDGET,
  RATE_LIMIT_REQUEST_BUDGET,
  RATE_LIMIT_STATE_PATH,
  activatePrivateModeCooldown,
  estimatePrivateModePromptTokens,
  isPrivateModeRateLimitError,
  rateLimitSnapshot,
  reservePrivateModeCapacity,
} from "./rate-limit.ts";

const CONTAINER_NAME = "privatemode-proxy";
const UPDATE_BACKUP_CONTAINER_NAME = `${CONTAINER_NAME}-update-backup`;
const IMAGE_VERSION = "v1.64.0";
const IMAGE_DIGEST = "sha256:cf046abd3f6cbccccc69cc742533607235b756cb497f8d23d4b02f42fc223334";
const IMAGE = `ghcr.io/edgelesssys/privatemode/privatemode-proxy@${IMAGE_DIGEST}`;
const CONTAINER_PORT = "8080"; // port inside the container (proxy default)
const WORKSPACE_VOLUME = "privatemode-proxy-workspace";
const WORKSPACE_DIR = "/app/privatemode-proxy";

const REFRESH_TIMEOUT_MS = 90_000;
const REFRESH_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 5_000;

export const FALLBACK_MODEL_IDS = [
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-oss-120b",
] as const;
const REMOVED_MODEL_IDS = new Set(["kimi-k2.6", "kimi-latest"]);

export interface PrivateModeModelEntry {
  id: string;
  object?: string;
  tasks?: string[];
}

interface ModelsResponse {
  data: PrivateModeModelEntry[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const podman = (pi: ExtensionAPI, args: string[]) => pi.exec("podman", args);

/** Is podman installed AND its engine usable (machine running on mac)?
 * Uses `podman ps` — the canonical engine-up check that works across podman
 * versions (unlike `podman info --format`, whose field paths vary). */
async function podmanReady(pi: ExtensionAPI): Promise<boolean> {
  const res = await podman(pi, ["ps"]);
  return res.code === 0;
}

async function containerState(
  pi: ExtensionAPI
): Promise<"running" | "stopped" | "absent"> {
  const res = await podman(pi, [
    "inspect",
    "-f",
    "{{.State.Running}}",
    CONTAINER_NAME,
  ]);
  if (res.code !== 0) return "absent";
  const out = res.stdout.trim();
  if (out === "true") return "running";
  if (out === "false") return "stopped";
  return "absent";
}

/**
 * Discover the host-side port the container publishes CONTAINER_PORT on.
 * `podman port <name> 8080/tcp` prints e.g. `127.0.0.1:34567`. Returns null if
 * the container has no mapping or doesn't exist.
 */
async function containerHostPort(pi: ExtensionAPI): Promise<string | null> {
  const res = await podman(pi, ["port", CONTAINER_NAME, `${CONTAINER_PORT}/tcp`]);
  if (res.code !== 0) return null;
  const line = res.stdout.trim().split("\n")[0]?.trim();
  if (!line) return null;
  // Accept "host:port" or a bare port number.
  if (/^\d+$/.test(line)) return `127.0.0.1:${line}`;
  if (/^[\d.]+:\d+$/.test(line) || /^\[?[0-9a-fA-F:]+\]?:\d+$/.test(line)) {
    return line;
  }
  return null;
}

function baseUrlFor(hostPort: string): string {
  return `http://${hostPort}/v1`;
}

class ProxyHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`proxy /v1/models returned HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "ProxyHttpError";
    this.status = status;
  }
}

/** Fetch /v1/models from the proxy. Sends the bearer key because the proxy
 * runs keyless and forwards the Authorization header to Privatemode. */
async function fetchModels(
  apiKey: string,
  baseUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ModelsResponse> {
  const ctrl = new AbortController();
  const forwardAbort = () => ctrl.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      throw new ProxyHttpError(resp.status, resp.statusText);
    }
    const body = (await resp.json()) as ModelsResponse;
    if (!body || !Array.isArray(body.data)) {
      throw new Error("proxy /v1/models returned unexpected JSON (no 'data' array)");
    }
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Create the named container from the pinned, already-selected image. */
async function createContainer(pi: ExtensionAPI): Promise<void> {
  // No --api-key: v1.64.0 forwards the client's Authorization header. The
  // pinned version supports the future kebab-case flags without yet requiring
  // an attestation key at startup.
  const res = await podman(pi, [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "-p",
    `127.0.0.1::${CONTAINER_PORT}`,
    "-v",
    `${WORKSPACE_VOLUME}:${WORKSPACE_DIR}`,
    IMAGE,
    "--disable-prompt-cache=false",
    "--workspace",
    WORKSPACE_DIR,
  ]);
  if (res.code !== 0) {
    throw new Error(`privatemode: 'podman run' for the proxy failed: ${res.stderr.trim()}`);
  }
}

/** Ensure the named container exists and is running. Existing containers are
 * deliberately reused without a pull or replacement so startup stays local. */
async function ensureContainerRunning(pi: ExtensionAPI): Promise<void> {
  const state = await containerState(pi);
  if (state === "running") return;

  if (state === "stopped") {
    const res = await podman(pi, ["start", CONTAINER_NAME]);
    if (res.code !== 0) {
      throw new Error(
        `privatemode: 'podman start ${CONTAINER_NAME}' failed: ${res.stderr.trim()}`
      );
    }
    return;
  }

  await createContainer(pi);
}

async function containerProxyVersion(pi: ExtensionAPI): Promise<string | null> {
  if ((await containerState(pi)) !== "running") return null;
  const res = await podman(pi, [
    "exec",
    CONTAINER_NAME,
    "/bin/privatemode-proxy",
    "--version",
  ]);
  if (res.code !== 0) return null;
  return res.stdout.match(/v\d+\.\d+\.\d+/)?.[0] ?? null;
}

async function containerImageRef(pi: ExtensionAPI): Promise<string | null> {
  const res = await podman(pi, [
    "inspect",
    "-f",
    "{{.ImageName}}",
    CONTAINER_NAME,
  ]);
  return res.code === 0 ? res.stdout.trim() || null : null;
}

async function waitForProxy(
  pi: ExtensionAPI,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<ModelsResponse> {
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("privatemode: model refresh cancelled");
    }
    try {
      return await fetchModels(apiKey, baseUrl, PROBE_TIMEOUT_MS, signal);
    } catch (e) {
      // Authentication and other client errors cannot improve by retrying. The
      // proxy itself can take a few seconds to return them, but startup no longer
      // waits for this path because remote discovery lives in refreshModels.
      if (e instanceof ProxyHttpError && e.status >= 400 && e.status < 500) {
        throw e;
      }
      if (signal?.aborted) {
        throw new Error("privatemode: model refresh cancelled");
      }
      lastErr = e;
      await sleep(REFRESH_POLL_MS);
    }
  }
  const logs = await podman(pi, ["logs", "--tail", "40", CONTAINER_NAME]);
  throw new Error(
    `privatemode: proxy did not become healthy within ${
      REFRESH_TIMEOUT_MS / 1000
    }s (base URL ${baseUrl}).\n` +
      `last probe error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }\n` +
      `container logs (tail 40):\n${logs.stdout || logs.stderr}`
  );
}

/** Pull and atomically replace the proxy container, rolling back the old
 * container if creation, attestation, catalog discovery, or version validation
 * fails. The workspace remains in its named volume across either path. */
async function updateContainer(
  pi: ExtensionAPI,
  apiKey: string
): Promise<{ baseUrl: string; version: string }> {
  const pull = await podman(pi, ["pull", IMAGE]);
  if (pull.code !== 0) {
    throw new Error(`privatemode: failed to pull ${IMAGE}: ${pull.stderr.trim()}`);
  }

  const oldState = await containerState(pi);
  const backupState = await (async () => {
    const res = await podman(pi, [
      "inspect",
      "-f",
      "{{.State.Running}}",
      UPDATE_BACKUP_CONTAINER_NAME,
    ]);
    return res.code === 0 ? "present" : "absent";
  })();
  if (backupState === "present") {
    throw new Error(
      `privatemode: update backup container ${UPDATE_BACKUP_CONTAINER_NAME} already exists; ` +
        "inspect or remove it before retrying"
    );
  }

  let backedUp = false;
  try {
    if (oldState !== "absent") {
      if (oldState === "running") {
        const stop = await podman(pi, ["stop", CONTAINER_NAME]);
        if (stop.code !== 0) {
          throw new Error(`failed to stop old proxy: ${stop.stderr.trim()}`);
        }
      }
      const rename = await podman(pi, [
        "rename",
        CONTAINER_NAME,
        UPDATE_BACKUP_CONTAINER_NAME,
      ]);
      if (rename.code !== 0) {
        throw new Error(`failed to back up old proxy container: ${rename.stderr.trim()}`);
      }
      backedUp = true;
    }

    await createContainer(pi);
    const hostPort = await containerHostPort(pi);
    if (!hostPort) {
      throw new Error("updated proxy has no published host port");
    }
    const baseUrl = baseUrlFor(hostPort);
    await waitForProxy(pi, apiKey, baseUrl);

    const version = await containerProxyVersion(pi);
    if (version !== IMAGE_VERSION) {
      throw new Error(
        `updated proxy reported ${version ?? "no version"}; expected ${IMAGE_VERSION}`
      );
    }

    if (backedUp) {
      const removeBackup = await podman(pi, ["rm", "-f", UPDATE_BACKUP_CONTAINER_NAME]);
      if (removeBackup.code !== 0) {
        throw new Error(
          `updated proxy is healthy, but removing backup container failed: ` +
            removeBackup.stderr.trim()
        );
      }
    }
    return { baseUrl, version };
  } catch (error) {
    const rollbackErrors: string[] = [];
    const removeNew = await podman(pi, ["rm", "-f", CONTAINER_NAME]);
    if (removeNew.code !== 0 && !/no such container/i.test(removeNew.stderr)) {
      rollbackErrors.push(`remove failed update: ${removeNew.stderr.trim()}`);
    }

    if (backedUp) {
      const renameBack = await podman(pi, [
        "rename",
        UPDATE_BACKUP_CONTAINER_NAME,
        CONTAINER_NAME,
      ]);
      if (renameBack.code !== 0) {
        rollbackErrors.push(`restore old container name: ${renameBack.stderr.trim()}`);
      } else if (oldState === "running") {
        const restartOld = await podman(pi, ["start", CONTAINER_NAME]);
        if (restartOld.code !== 0) {
          rollbackErrors.push(`restart old container: ${restartOld.stderr.trim()}`);
        }
      }
    }

    const cause = error instanceof Error ? error.message : String(error);
    const rollback =
      rollbackErrors.length > 0
        ? `; rollback also failed: ${rollbackErrors.join("; ")}`
        : backedUp
          ? "; previous proxy restored"
          : "";
    throw new Error(`privatemode: proxy update failed: ${cause}${rollback}`);
  }
}

/** Ensure the local proxy exists and return its dynamically published URL.
 * Remote health/model discovery is deliberately deferred to refreshModels. */
async function resolveProxyLocation(pi: ExtensionAPI): Promise<string> {
  await ensureContainerRunning(pi);
  const hostPort = await containerHostPort(pi);
  if (!hostPort) {
    throw new Error(
      `privatemode: container ${CONTAINER_NAME} is running but has no host port ` +
        `mapping for ${CONTAINER_PORT}/tcp. Recreate it with 'podman rm -f ${CONTAINER_NAME}' ` +
        `and restart pi.`
    );
  }
  return baseUrlFor(hostPort);
}

const NON_CHAT = /whisper|voxtral|embedding|tts|speech|deepseek-ocr/i;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const GLM_THINKING_LEVELS = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} as const;
const GPT_OSS_THINKING_LEVELS = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
} as const;

function isPiChatModel(model: PrivateModeModelEntry): boolean {
  if (REMOVED_MODEL_IDS.has(model.id) || NON_CHAT.test(model.id)) return false;
  if (!model.tasks) return true;
  return model.tasks.includes("generate") && model.tasks.includes("tool_calling");
}

function modelConfig(model: PrivateModeModelEntry) {
  const { id } = model;
  const isGlm = id.startsWith("glm-");
  const isGlmFlash = /glm-(?:5\.3-)?flash|glm-flash-latest/.test(id);
  const isGptOss = /(?:^|\/)gpt-oss-(?:120b|latest)$/.test(id);
  const hasVision = model.tasks?.includes("vision") ?? isGlmFlash;

  const contextWindow = isGlm ? 1_000_000 : isGptOss ? 131_072 : 128_000;
  // Privatemode publishes a 128k GLM output cap. gpt-oss has a 128k total
  // context but no separate published output cap, so use a conservative 32k.
  const maxTokens = isGlm ? 131_072 : isGptOss ? 32_768 : 16_384;

  return {
    type: "chat" as const,
    id,
    name: id,
    reasoning: true,
    thinkingLevelMap: isGlm
      ? GLM_THINKING_LEVELS
      : isGptOss
        ? GPT_OSS_THINKING_LEVELS
        : undefined,
    input: (hasVision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    // Published prices are denominated in EUR, while Pi's cost schema requires
    // USD. Keep accounting at zero rather than silently treating EUR as USD.
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens" as const,
      supportsStrictMode: true,
    },
  };
}

export function configsFromModelEntries(models: readonly PrivateModeModelEntry[]) {
  return models.filter(isPiChatModel).map(modelConfig);
}

function configsFromIds(ids: readonly string[]) {
  return configsFromModelEntries(ids.map((id) => ({ id })));
}

export default async function (pi: ExtensionAPI) {
  let loadError: string | null = null;
  let refreshError: string | null = null;
  let activeBaseUrl: string | null = null;
  let activeProxyVersion: string | null = null;
  let proxyVersionWarning: string | null = null;
  const apiKey = process.env.PRIVATEMODE_API_KEY;

  try {
    if (!apiKey) {
      throw new Error(
        "PRIVATEMODE_API_KEY env var is not set. Create a key at " +
          "https://portal.privatemode.ai/ and export it as PRIVATEMODE_API_KEY."
      );
    }

    if (!(await podmanReady(pi))) {
      const probe = await podman(pi, ["ps"]);
      throw new Error(
        "podman is not available (not installed, or its machine/engine isn't " +
          "running). PrivateMode needs the local podman proxy for client-side " +
          "encryption; there is no plaintext remote endpoint. Install/start " +
          "podman, then restart pi.\n" +
          `podman stderr: ${probe.stderr.trim() || "(empty)"}`
      );
    }

    activeBaseUrl = await resolveProxyLocation(pi);
    activeProxyVersion = await containerProxyVersion(pi);
    if (activeProxyVersion !== IMAGE_VERSION) {
      proxyVersionWarning =
        `PrivateMode proxy is ${activeProxyVersion ?? "an unknown version"}; ` +
        `${IMAGE_VERSION} is pinned. Run /privatemode update.`;
      console.warn(`[privatemode] ${proxyVersionWarning}`);
    }
    const baseUrl = activeBaseUrl;
    pi.registerProvider("privatemode", {
      name: "PrivateMode AI",
      baseUrl,
      apiKey: "$PRIVATEMODE_API_KEY",
      api: "openai-completions",
      // Seed startup synchronously. Successful discovery persists the current
      // catalog; the seed contains only canonical, currently supported models.
      models: configsFromIds(FALLBACK_MODEL_IDS),
      refreshModels: async (context) => {
        const storedIds = context.stored?.models.map((model) => model.id) ?? [];
        const cached = configsFromIds(storedIds);
        if (!context.allowNetwork) {
          return cached.length > 0 ? cached : configsFromIds(FALLBACK_MODEL_IDS);
        }

        try {
          let models: ModelsResponse;
          try {
            models = await fetchModels(
              apiKey,
              baseUrl,
              PROBE_TIMEOUT_MS,
              context.signal
            );
          } catch (e) {
            if (e instanceof ProxyHttpError && e.status >= 400 && e.status < 500) {
              throw e;
            }
            models = await waitForProxy(pi, apiKey, baseUrl, context.signal);
          }

          const discovered = configsFromModelEntries(models.data);
          if (discovered.length === 0) {
            throw new Error(
              "proxy /v1/models returned no chat models (got: " +
                `${JSON.stringify(models.data.map((model) => model.id))})`
            );
          }
          refreshError = null;
          await context.publish({
            persist: {
              checkedAt: Date.now(),
              models: discovered.map((model) => ({
                ...model,
                provider: "privatemode",
                baseUrl,
                api: "openai-completions" as const,
              })),
            },
          });
          return discovered;
        } catch (e) {
          refreshError = e instanceof Error ? e.message : String(e);
          throw e;
        }
      },
    });

    pi.on("before_provider_request", async (event, ctx) => {
      if (ctx.model?.provider !== "privatemode") return;
      const estimatedTokens = estimatePrivateModePromptTokens(event.payload);
      try {
        const result = await reservePrivateModeCapacity(
          estimatedTokens,
          ctx.signal,
          (waitMs) => {
            const seconds = Math.max(1, Math.ceil(waitMs / 1000));
            const message =
              `PrivateMode local rate limit: waiting about ${seconds}s before sending ` +
              `an estimated ${estimatedTokens.toLocaleString()}-token request.`;
            if (ctx.hasUI) ctx.ui.notify(message, "info");
            else console.warn(`[privatemode] ${message}`);
          }
        );
        if (result.waitedMs >= 1_000) {
          console.warn(
            `[privatemode] rate-limit wait completed after ${Math.ceil(
              result.waitedMs / 1000
            )}s; ${result.usedTokens.toLocaleString()} estimated tokens reserved ` +
              `across ${result.requestCount} request(s) in the current window`
          );
        }
      } catch (error) {
        // Pi reports extension-hook exceptions but otherwise continues the provider
        // request. Abort explicitly so a broken limiter or impossible request fails
        // closed instead of bypassing the configured local budget.
        ctx.abort();
        throw error;
      }
    });

    pi.on("message_end", async (event, ctx) => {
      if (
        event.message.role !== "assistant" ||
        event.message.provider !== "privatemode" ||
        !isPrivateModeRateLimitError(event.message.errorMessage)
      ) {
        return;
      }
      try {
        await activatePrivateModeCooldown();
        const message =
          "PrivateMode upstream rate limit reached; local requests are paused for about 60s before the automatic retry.";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(`[privatemode] ${message}`);
      } catch (error) {
        ctx.abort();
        throw error;
      }
    });
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    // Non-fatal: warn loudly but do NOT rethrow — throwing aborts pi startup
    // entirely. Pi continues with its other providers; inspect via /privatemode.
    console.warn(`[privatemode] provider unavailable: ${loadError}`);
  }

  // Surface local setup failures and stale proxy versions interactively too.
  // console.warn covers non-UI modes, including print and RPC startup.
  if (loadError || proxyVersionWarning) {
    pi.on("session_start", (_event, ctx) => {
      if (loadError) {
        ctx.ui.notify(`PrivateMode AI unavailable: ${loadError}`, "warning");
      } else if (proxyVersionWarning) {
        ctx.ui.notify(proxyVersionWarning, "warning");
      }
    });
  }

  // Always register the command so the user can inspect/troubleshoot — even
  // when the provider couldn't be registered.
  pi.registerCommand("privatemode", {
    description: "PrivateMode proxy: status | logs | restart | update",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0] || "status";

      if (sub === "update") {
        if (!(await podmanReady(pi))) {
          ctx.ui.notify("podman not available — can't update the PrivateMode proxy.", "error");
          return;
        }
        if (!apiKey) {
          ctx.ui.notify("PRIVATEMODE_API_KEY not set — can't verify the updated proxy.", "error");
          return;
        }
        const currentVersion = await containerProxyVersion(pi);
        const currentImage = await containerImageRef(pi);
        if (currentVersion === IMAGE_VERSION && currentImage === IMAGE) {
          ctx.ui.notify(`PrivateMode proxy is already pinned at ${IMAGE_VERSION}.`, "info");
          return;
        }
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Update PrivateMode proxy?",
            "This briefly stops the shared proxy and may interrupt other Pi sessions."
          );
          if (!confirmed) return;
        }
        ctx.ui.notify(`Updating PrivateMode proxy to ${IMAGE_VERSION}…`, "info");
        try {
          const updated = await updateContainer(pi, apiKey);
          activeBaseUrl = updated.baseUrl;
          activeProxyVersion = updated.version;
          proxyVersionWarning = null;
          refreshError = null;
          ctx.ui.notify(
            `PrivateMode proxy updated to ${updated.version} at ${updated.baseUrl}. Reloading Pi…`,
            "info"
          );
          await ctx.reload();
          return;
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
          return;
        }
      }

      if (sub === "restart") {
        if (!(await podmanReady(pi))) {
          ctx.ui.notify(
            "podman not available — can't restart the PrivateMode proxy.",
            "error"
          );
          return;
        }
        ctx.ui.notify("Restarting PrivateMode proxy…", "info");
        const r = await podman(pi, ["restart", CONTAINER_NAME]);
        if (r.code !== 0) {
          ctx.ui.notify(`restart failed: ${r.stderr.trim()}`, "error");
          return;
        }
        const hostPort = await containerHostPort(pi);
        if (!hostPort) {
          ctx.ui.notify(
            "proxy restarted but no host port mapping found.",
            "error"
          );
          return;
        }
        const baseUrl = baseUrlFor(hostPort);
        try {
          if (!apiKey) throw new Error("PRIVATEMODE_API_KEY not set");
          await waitForProxy(pi, apiKey, baseUrl);
          activeBaseUrl = baseUrl;
          refreshError = null;
          ctx.ui.notify(
            `PrivateMode proxy restarted and healthy at ${baseUrl}.`,
            "info"
          );
        } catch (e) {
          refreshError = e instanceof Error ? e.message : String(e);
          ctx.ui.notify(
            `proxy restarted but health check failed: ${refreshError}`,
            "error"
          );
        }
        return;
      }

      if (sub === "logs") {
        const r = await podman(pi, ["logs", "--tail", "50", CONTAINER_NAME]);
        ctx.ui.notify(r.stdout || r.stderr || "(no logs)", "info");
        return;
      }

      // status
      if (loadError && !activeBaseUrl) {
        ctx.ui.notify(`PrivateMode unavailable: ${loadError}`, "warning");
        return;
      }
      const state = await containerState(pi);
      const hostPort = await containerHostPort(pi);
      const imageRef = await containerImageRef(pi);
      activeProxyVersion = await containerProxyVersion(pi);
      let line = `proxy container: ${state}`;
      line += `\nproxy version: ${activeProxyVersion ?? "(unknown)"}`;
      line += `\npinned version: ${IMAGE_VERSION}`;
      line += `\ncontainer image: ${imageRef ?? "(unknown)"}`;
      line += `\nhost port: ${hostPort ?? "(none)"}`;
      if (activeBaseUrl) line += `\nbase URL: ${activeBaseUrl}`;
      if (activeProxyVersion !== IMAGE_VERSION) {
        line += "\nupdate available: run /privatemode update";
      }
      if (refreshError) line += `\nlast refresh error: ${refreshError}`;
      try {
        const limiter = await rateLimitSnapshot();
        line += `\nlocal limiter: ${limiter.usedTokens.toLocaleString()}/${RATE_LIMIT_CACHED_TOKEN_BUDGET.toLocaleString()} estimated cached tokens`;
        line += `, ${limiter.requestCount}/${RATE_LIMIT_REQUEST_BUDGET} requests in 60s`;
        if (limiter.nextResetMs > 0) {
          line += `; next release in ${Math.ceil(limiter.nextResetMs / 1000)}s`;
        }
        line += `\nlimiter state: ${RATE_LIMIT_STATE_PATH}`;
      } catch (e) {
        line += `\nlocal limiter error: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (hostPort && apiKey) {
        try {
          const response = await fetchModels(apiKey, baseUrlFor(hostPort));
          const surfaced = configsFromModelEntries(response.data);
          const surfacedIds = new Set(surfaced.map((model) => model.id));
          const excluded = response.data
            .map((model) => model.id)
            .filter((id) => !surfacedIds.has(id));
          line += `\nPi chat models (${surfaced.length}): ${surfaced
            .map((model) => model.id)
            .join(", ")}`;
          if (excluded.length > 0) {
            line += `\nexcluded non-chat/specialized models (${excluded.length}): ${excluded.join(", ")}`;
          }
        } catch (e) {
          line += `\nprobe failed: ${e instanceof Error ? e.message : e}`;
        }
      }
      ctx.ui.notify(line, "info");
    },
  });
}
