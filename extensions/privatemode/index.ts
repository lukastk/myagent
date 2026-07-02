/**
 * PrivateMode AI provider extension.
 *
 * Registers PrivateMode AI (https://privatemode.ai) as an OpenAI-compatible
 * provider. PrivateMode is end-to-end encrypted via confidential computing; it
 * requires a local proxy (Docker) that does client-side encryption + remote
 * attestation before anything leaves your machine. This extension auto-starts
 * that proxy on demand and reuses a running instance across pi sessions.
 *
 * The proxy is started WITHOUT `--apiKey`, so it forwards the client's
 * Authorization header to Privatemode. pi holds $PRIVATEMODE_API_KEY and
 * authenticates per request — the key never lives in docker args or the
 * container, and key rotation needs no proxy restart.
 *
 * Lifecycle: the container runs with `--restart unless-stopped`, so once
 * started it persists across pi sessions and reboots. Multiple pi sessions
 * share it for free: each just probes 127.0.0.1:8080 and reuses whatever is
 * already healthy. Stop it deliberately with `docker stop privatemode-proxy`.
 *
 * `/privatemode`            — show proxy + model status
 * `/privatemode logs`       — tail proxy container logs
 * `/privatemode restart`    — restart the proxy container and re-healthcheck
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROXY_PORT = 8080;
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1`;
const CONTAINER_NAME = "privatemode-proxy";
const IMAGE = "ghcr.io/edgelesssys/privatemode/privatemode-proxy:latest";
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

/** Fetch /v1/models from the proxy. Sends the bearer key because the proxy
 * runs keyless and forwards the Authorization header to Privatemode. */
async function fetchModels(
  apiKey: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ModelsResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE_URL}/models`, {
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

async function containerState(
  pi: ExtensionAPI
): Promise<"running" | "stopped" | "absent"> {
  const res = await pi.exec("docker", [
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

async function ensureDocker(pi: ExtensionAPI): Promise<void> {
  const res = await pi.exec("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (res.code !== 0) {
    throw new Error(
      "privatemode: Docker is required to run the PrivateMode proxy but is not " +
        "available (the proxy does client-side encryption + remote attestation; " +
        "there is no plaintext remote endpoint).\n" +
        "Install Docker: https://docs.docker.com/engine/install/\n" +
        `docker stderr: ${res.stderr.trim()}`
    );
  }
}

async function startProxyContainer(pi: ExtensionAPI): Promise<void> {
  const state = await containerState(pi);
  if (state === "running") return; // already up; caller will wait for readiness

  if (state === "stopped") {
    const res = await pi.exec("docker", ["start", CONTAINER_NAME]);
    if (res.code !== 0) {
      throw new Error(
        `privatemode: 'docker start ${CONTAINER_NAME}' failed: ${res.stderr.trim()}`
      );
    }
    return;
  }

  // absent → create + run. No --apiKey: the proxy forwards the client's
  // Authorization header to Privatemode, so pi authenticates per request.
  const res = await pi.exec("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    "unless-stopped",
    "-p",
    `${PROXY_PORT}:${PROXY_PORT}`,
    "-v",
    `${WORKSPACE_VOLUME}:${WORKSPACE_DIR}`,
    IMAGE,
    "--sharedPromptCache",
    "--workspace",
    WORKSPACE_DIR,
  ]);
  if (res.code !== 0) {
    const err = res.stderr.trim();
    if (err.includes("port is already allocated") || err.includes("Bind for")) {
      throw new Error(
        `privatemode: port ${PROXY_PORT} is already in use by another process ` +
          `that is not the PrivateMode proxy (probe failed). Free port ${PROXY_PORT} ` +
          `or find what's on it, then restart pi.\n` +
          `docker stderr: ${err}`
      );
    }
    throw new Error(`privatemode: 'docker run' for the proxy failed: ${err}`);
  }
}

async function waitForProxy(pi: ExtensionAPI, apiKey: string): Promise<ModelsResponse> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchModels(apiKey);
    } catch (e) {
      lastErr = e;
      await sleep(STARTUP_POLL_MS);
    }
  }
  const logs = await pi.exec("docker", ["logs", "--tail", "40", CONTAINER_NAME]);
  throw new Error(
    `privatemode: proxy did not become healthy within ${
      STARTUP_TIMEOUT_MS / 1000
    }s.\n` +
      `last probe error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }\n` +
      `container logs (tail 40):\n${logs.stdout || logs.stderr}`
  );
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
  const apiKey = process.env.PRIVATEMODE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "privatemode: PRIVATEMODE_API_KEY env var is not set. Create a key at " +
        "https://portal.privatemode.ai/ and export it as PRIVATEMODE_API_KEY."
    );
  }

  // 1. Probe for an already-running proxy. This is how multiple pi sessions
  //    reuse one shared proxy — they all just probe 127.0.0.1:8080.
  let models: ModelsResponse;
  try {
    models = await fetchModels(apiKey);
  } catch {
    // 2. No healthy proxy — start one (idempotent: reuses container if present).
    await ensureDocker(pi);
    await startProxyContainer(pi);
    models = await waitForProxy(pi, apiKey);
  }

  const chatModelIds = models.data.map((m) => m.id).filter(isChatModel);
  if (chatModelIds.length === 0) {
    throw new Error(
      "privatemode: proxy /v1/models returned no chat models (got: " +
        `${JSON.stringify(models.data.map((m) => m.id))})`
    );
  }

  pi.registerProvider("privatemode", {
    name: "PrivateMode AI",
    baseUrl: BASE_URL,
    apiKey: "$PRIVATEMODE_API_KEY",
    api: "openai-completions",
    models: chatModelIds.map(modelConfig),
  });

  pi.registerCommand("privatemode", {
    description: "PrivateMode proxy: status | logs | restart",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0] || "status";

      if (sub === "restart") {
        ctx.ui.notify("Restarting PrivateMode proxy…", "info");
        const r = await pi.exec("docker", ["restart", CONTAINER_NAME]);
        if (r.code !== 0) {
          ctx.ui.notify(`restart failed: ${r.stderr.trim()}`, "error");
          return;
        }
        try {
          await waitForProxy(pi);
          ctx.ui.notify("PrivateMode proxy restarted and healthy.", "info");
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
        const r = await pi.exec("docker", ["logs", "--tail", "50", CONTAINER_NAME]);
        ctx.ui.notify(r.stdout || r.stderr || "(no logs)", "info");
        return;
      }

      // status
      const state = await containerState(pi);
      let line = `proxy container: ${state}`;
      try {
        const m = await fetchModels(apiKey);
        line += `\nmodels (${m.data.length}): ${m.data
          .map((x) => x.id)
          .join(", ")}`;
      } catch (e) {
        line += `\nprobe failed: ${e instanceof Error ? e.message : e}`;
      }
      ctx.ui.notify(line, "info");
    },
  });
}
