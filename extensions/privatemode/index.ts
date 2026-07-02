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
 * Non-fatal load: if anything goes wrong (no podman, proxy won't come up, no
 * models, missing API key) this extension NEVER throws — throwing aborts pi
 * startup entirely (which is what bricked pi on macstudio). It warns loudly
 * (console + an interactive `session_start` notification) and registers
 * nothing, so pi continues with its other providers.
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

const STARTUP_TIMEOUT_MS = 90_000;
const STARTUP_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 3_000;

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

/** Fetch /v1/models from the proxy. Sends the bearer key because the proxy
 * runs keyless and forwards the Authorization header to Privatemode. */
async function fetchModels(
  apiKey: string,
  baseUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ModelsResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      throw new Error(`proxy /v1/models returned HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as ModelsResponse;
    if (!body || !Array.isArray(body.data)) {
      throw new Error("proxy /v1/models returned unexpected JSON (no 'data' array)");
    }
    return body;
  } finally {
    clearTimeout(timer);
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
  baseUrl: string
): Promise<ModelsResponse> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchModels(apiKey, baseUrl);
    } catch (e) {
      lastErr = e;
      await sleep(STARTUP_POLL_MS);
    }
  }
  const logs = await podman(pi, ["logs", "--tail", "40", CONTAINER_NAME]);
  throw new Error(
    `privatemode: proxy did not become healthy within ${
      STARTUP_TIMEOUT_MS / 1000
    }s (base URL ${baseUrl}).\n` +
      `last probe error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }\n` +
      `container logs (tail 40):\n${logs.stdout || logs.stderr}`
  );
}

/**
 * Resolve the proxy's base URL and a healthy model list. Ensures the container
 * is running, discovers its host port, and probes until healthy.
 */
async function resolveProxy(
  pi: ExtensionAPI,
  apiKey: string
): Promise<{ baseUrl: string; models: ModelsResponse }> {
  await ensureContainerRunning(pi);
  const hostPort = await containerHostPort(pi);
  if (!hostPort) {
    throw new Error(
      `privatemode: container ${CONTAINER_NAME} is running but has no host port ` +
        `mapping for ${CONTAINER_PORT}/tcp. Recreate it with 'podman rm -f ${CONTAINER_NAME}' ` +
        `and restart pi.`
    );
  }
  const baseUrl = baseUrlFor(hostPort);
  let models: ModelsResponse;
  try {
    models = await fetchModels(apiKey, baseUrl);
  } catch {
    models = await waitForProxy(pi, apiKey, baseUrl);
  }
  return { baseUrl, models };
}

// Models surfaced by /v1/models that aren't chat-completion models.
const NON_CHAT = /whisper|voxtral|embedding|tts|speech/i;
const isChatModel = (id: string): boolean => !NON_CHAT.test(id);

function modelConfig(id: string) {
  const reasoning = /kimi|gpt-oss/i.test(id);
  const isKimi = /kimi/i.test(id);
  return {
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

export default async function (pi: ExtensionAPI) {
  let loadError: string | null = null;
  let activeBaseUrl: string | null = null;
  let apiKey: string | undefined = process.env.PRIVATEMODE_API_KEY;

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

    const { baseUrl, models } = await resolveProxy(pi, apiKey);
    const chatModelIds = models.data.map((m) => m.id).filter(isChatModel);
    if (chatModelIds.length === 0) {
      throw new Error(
        "proxy /v1/models returned no chat models (got: " +
          `${JSON.stringify(models.data.map((m) => m.id))})`
      );
    }

    activeBaseUrl = baseUrl;
    pi.registerProvider("privatemode", {
      name: "PrivateMode AI",
      baseUrl,
      apiKey: "$PRIVATEMODE_API_KEY",
      api: "openai-completions",
      models: chatModelIds.map(modelConfig),
    });
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    // Non-fatal: warn loudly but do NOT rethrow — throwing aborts pi startup
    // entirely (which is what bricked pi on macstudio). pi continues with its
    // other providers; the user can inspect via /privatemode.
    console.warn(`[privatemode] provider unavailable: ${loadError}`);
  }

  // Surface the load failure interactively too (console.warn covers all modes,
  // including print/RPC where session_start may not fire).
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
          ctx.ui.notify(
            `PrivateMode proxy restarted and healthy at ${baseUrl}.`,
            "info"
          );
        } catch (e) {
          ctx.ui.notify(
            `proxy restarted but health check failed: ${
              e instanceof Error ? e.message : e
            }`,
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
      if (hostPort && apiKey) {
        try {
          const m = await fetchModels(apiKey, baseUrlFor(hostPort));
          line += `\nmodels (${m.data.length}): ${m.data
            .map((x) => x.id)
            .join(", ")}`;
        } catch (e) {
          line += `\nprobe failed: ${e instanceof Error ? e.message : e}`;
        }
      }
      ctx.ui.notify(line, "info");
    },
  });
}
