/**
 * RPC Socket Extension for Pi
 *
 * Opens a Unix socket server inside the interactive TUI session so external
 * processes can inject messages into the live conversation.
 *
 * Each session gets its own socket at /tmp/pi-rpc-sockets/<sessionId>.sock.
 *
 * Protocol:
 *   Send message:  {"message":"prompt text"}\n  →  {"ok":true,"delivered":"prompt text"}\n
 *   Subscribe:     {"subscribe":true}\n         →  {"ok":true,"subscribed":true}\n
 *
 * Subscribed connections receive Pi events as JSONL:
 *   {"event":"text_delta","delta":"Hello "}\n
 *   {"event":"tool_execution_start","toolName":"web_search"}\n
 *   {"event":"tool_execution_end","toolName":"web_search"}\n
 *   {"event":"agent_end"}\n
 */
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SOCKETS_DIR = "/tmp/pi-rpc-sockets";

export default function (pi: ExtensionAPI) {
	let server: net.Server | null = null;
	let socketPath: string | null = null;
	const subscribers = new Set<net.Socket>();

	// Broadcast an event to all subscribed connections
	function broadcast(data: Record<string, unknown>) {
		const line = JSON.stringify(data) + "\n";
		for (const conn of subscribers) {
			try {
				conn.write(line);
			} catch {
				subscribers.delete(conn);
			}
		}
	}

	// Forward Pi events to subscribers
	pi.on("message_update", async (event) => {
		const evt = (event as any).assistantMessageEvent;
		if (evt?.type === "text_delta") {
			broadcast({ event: "text_delta", delta: evt.delta });
		}
	});

	pi.on("tool_execution_start", async (event) => {
		broadcast({
			event: "tool_execution_start",
			toolName: (event as any).toolName,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		broadcast({
			event: "tool_execution_end",
			toolName: (event as any).toolName,
		});
	});

	pi.on("agent_end", async () => {
		broadcast({ event: "agent_end" });
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();

		fs.mkdirSync(SOCKETS_DIR, { recursive: true });

		socketPath = path.join(SOCKETS_DIR, `${sessionId}.sock`);

		// Clean up stale socket file from previous runs
		try {
			fs.unlinkSync(socketPath);
		} catch {
			// doesn't exist, fine
		}

		server = net.createServer((conn) => {
			let buffer = "";

			conn.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				// Keep the last (possibly incomplete) chunk in the buffer
				buffer = lines.pop()!;

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const parsed = JSON.parse(trimmed);

						// Subscribe to Pi events
						if (parsed.subscribe === true) {
							subscribers.add(conn);
							conn.write(JSON.stringify({ ok: true, subscribed: true }) + "\n");
							continue;
						}

						const message = parsed.message;
						if (typeof message !== "string" || !message.trim()) {
							conn.write(JSON.stringify({ error: "missing 'message' field" }) + "\n");
							continue;
						}

						pi.sendUserMessage(message, { deliverAs: "steer" });
						conn.write(JSON.stringify({ ok: true, delivered: message }) + "\n");
					} catch (e: any) {
						conn.write(JSON.stringify({ error: `invalid JSON: ${e.message}` }) + "\n");
					}
				}
			});

			conn.on("close", () => {
				subscribers.delete(conn);
			});

			conn.on("error", () => {
				subscribers.delete(conn);
			});
		});

		server.listen(socketPath, () => {
			if (ctx.hasUI) {
				ctx.ui.notify(`RPC socket: ${socketPath}`, "info");
			}
		});

		server.on("error", (err) => {
			if (ctx.hasUI) {
				ctx.ui.notify(`RPC socket error: ${err.message}`, "error");
			}
		});
	});

	pi.on("session_shutdown", async () => {
		subscribers.clear();
		if (server) {
			server.close();
			server = null;
		}
		if (socketPath) {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// already gone
			}
			socketPath = null;
		}
	});
}
