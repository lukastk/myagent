/**
 * RPC Socket Extension for Pi
 *
 * Opens a Unix socket server inside the interactive TUI session so external
 * processes can inject messages into the live conversation.
 *
 * Each session gets its own socket at /tmp/pi-rpc-sockets/<sessionId>.sock.
 */
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SOCKETS_DIR = "/tmp/pi-rpc-sockets";

export default function (pi: ExtensionAPI) {
	let server: net.Server | null = null;
	let socketPath: string | null = null;

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
