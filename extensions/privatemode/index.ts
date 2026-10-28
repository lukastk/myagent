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
 * Keyless proxy: started WITHOUT `--apiKey`, so the proxy forwards the client's
 * Authorization header to Privatemode. pi holds $PRIVATEMODE_API_KEY and
 * authenticates per request — the key never lives in podman args, and key
 * rotation needs no proxy restart.
 *
 * Cross-session reuse: every pi session looks up the existing
 * `privatemode-proxy` container, reads its published port via `podman port`,
 * and reuses it. Only the first session creates the container. The container
 * runs with `--restart unless-stopped`, so it survives pi crashes and (on
 * Linux) reboots; stop it deliberately with `podman stop privatemode-proxy`.
 *
 * Non-blocking startup: extension loading performs local podman/container setup
 * only. It registers a small known-good model seed immediately and uses Pi's
 * `refreshModels` lifecycle for remote `/v1/models` discovery. Pi calls that
 * lifecycle cache-only during startup, so an expired key or unavailable remote
 * service cannot hold every Pi launch for the proxy's retry window. Opening the
 * model picker performs the cancellable network refresh and persists its catalog.
 *
 * Non-fatal load: if local setup fails (no podman, proxy cannot start, missing
 * key) this extension NEVER throws — throwing aborts pi startup entirely. It
 * warns loudly (console + an interactive `session_start` notification) and
 * registers nothing, so pi continues with its other providers.
 *
 * `/privatemode`            — show proxy + model status (or why it's unavailable)
 * `/privatemode logs`       — tail proxy container logs
 * `/privatemode restart`    — restart the proxy container and re-healthcheck
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTAINER_NAME = "privatemode-proxy";
const IMAGE = "ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest";
const CONTAINER_PORT = "8080"; // port inside the container (proxy default)
const WORKSPACE_VOLUME = "privatemode-proxy-workspace";
const WORKSPACE_DIR = "/app/privatemode-proxy";

const REFRESH_TIMEOUT_MS = 90_000;
const REFRESH_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 5_000;
const FALLBACK_MODEL_IDS = ["gpt-oss-120b", "kimi-k2.6"] as const;

interface ModelsResponse {
  data: Array<{ id: string }>;
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
  constructor(
    readonly status: number,
    statusText: string
  ) {
    super(`proxy /v1/models returned HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "ProxyHttpError";
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

/** Ensure the named container exists and is running. Creates or starts it. */
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

  // absent → create + run. No --apiKey: the proxy forwards the client's
  // Authorization header to Privatemode, so pi authenticates per request.
  // -p 127.0.0.1::8080 → publish container's 8080 on an auto-assigned
  // loopback host port (avoids colliding with anything on a fixed port).
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
    "--sharedPromptCache",
    "--workspace",
    WORKSPACE_DIR,
  ]);
  if (res.code !== 0) {
    throw new Error(`privatemode: 'podman run' for the proxy failed: ${res.stderr.trim()}`);
  }
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

// Models surfaced by /v1/models that aren't chat-completion models.
const NON_CHAT = /whisper|voxtral|embedding|tts|speech/i;
const isChatModel = (id: string): boolean => !NON_CHAT.test(id);

function modelConfig(id: string) {
  const reasoning = /kimi|gpt-oss/i.test(id);
  const isKimi = /kimi/i.test(id);
  return {
    type: "chat" as const,
    id,
    name: id,
    reasoning,
    input: ["text", "image"] as ("text" | "image")[],
    // Pricing isn't exposed by /v1/models; left at 0 so cost tracking simply
    // reports zero rather than inventing numbers. Set real values from the
    // portal billing page if you want accurate usage cost.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: isKimi ? 32000 : 8192,
  };
}

function configsFromIds(ids: readonly string[]) {
  return ids.filter(isChatModel).map(modelConfig);
}

export default async function (pi: ExtensionAPI) {
  let loadError: string | null = null;
  let refreshError: string | null = null;
  let activeBaseUrl: string | null = null;
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
    const baseUrl = activeBaseUrl;
    pi.registerProvider("privatemode", {
      name: "PrivateMode AI",
      baseUrl,
      apiKey: "$PRIVATEMODE_API_KEY",
      api: "openai-completions",
      // Seed startup synchronously. A successful refresh persists and restores
      // the provider's current IDs; these two keep the configured scope stable
      // before the first successful discovery on a machine.
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

          const discovered = configsFromIds(models.data.map((model) => model.id));
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
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    // Non-fatal: warn loudly but do NOT rethrow — throwing aborts pi startup
    // entirely. Pi continues with its other providers; inspect via /privatemode.
    console.warn(`[privatemode] provider unavailable: ${loadError}`);
  }

  // Surface local setup failure interactively too (console.warn covers all
  // modes, including print/RPC where session_start may not fire). Remote/auth
  // failures happen only during explicit refresh/status operations.
  if (loadError) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`PrivateMode AI unavailable: ${loadError}`, "warning");
    });
  }

  // Always register the command so the user can inspect/troubleshoot — even
  // when the provider couldn't be registered.
  pi.registerCommand("privatemode", {
    description: "PrivateMode proxy: status | logs | restart",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0] || "status";

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
      let line = `proxy container: ${state}`;
      line += `\nhost port: ${hostPort ?? "(none)"}`;
      if (activeBaseUrl) line += `\nbase URL: ${activeBaseUrl}`;
      if (refreshError) line += `\nlast refresh error: ${refreshError}`;
      if (hostPort && apiKey) {
        try {
          const m = await fetchModels(apiKey, baseUrlFor(hostPort));
          line += `\nmodels (${m.data.length}): ${m.data
            .map((model) => model.id)
            .join(", ")}`;
        } catch (e) {
          line += `\nprobe failed: ${e instanceof Error ? e.message : e}`;
        }
      }
      ctx.ui.notify(line, "info");
    },
  });
}
