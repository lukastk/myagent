# RPC Socket Extension

Opens a Unix socket server inside the interactive TUI session so external processes can inject messages into the live conversation. Each session gets its own socket, so multiple pi sessions can run simultaneously.

## How it works

On `session_start`, the extension creates a Unix socket at `/tmp/pi-rpc-sockets/<sessionId>.sock`. External processes connect, send a JSON message, and it appears in the TUI as a user turn via `sendUserMessage` with `deliverAs: "steer"`.

On `session_shutdown`, the socket is cleaned up.

## Protocol

One JSON object per line (LF-delimited):

| Direction | Format |
|---|---|
| Send message | `{"message":"your prompt text"}\n` |
| Subscribe to events | `{"subscribe":true}\n` |
| Success (send) | `{"ok":true,"delivered":"your prompt text"}\n` |
| Success (subscribe) | `{"ok":true,"subscribed":true}\n` |
| Error | `{"error":"reason"}\n` |

Subscribed connections receive Pi events as JSONL:

| Event | Format |
|---|---|
| Text delta | `{"event":"text_delta","delta":"Hello "}` |
| Tool start | `{"event":"tool_execution_start","toolName":"web_search"}` |
| Tool end | `{"event":"tool_execution_end","toolName":"web_search"}` |
| Agent done | `{"event":"agent_end"}` |

## Usage

### Discover active sessions

```bash
ls /tmp/pi-rpc-sockets/
```

### Send a message

```bash
echo '{"message":"Run the tests"}' | nc -U /tmp/pi-rpc-sockets/<sessionId>.sock
```

Or target the first available session:

```bash
echo '{"message":"Run the tests"}' | nc -U $(ls /tmp/pi-rpc-sockets/*.sock | head -1)
```

### From Node.js

```typescript
import * as net from "node:net";

const conn = net.createConnection("/tmp/pi-rpc-sockets/<sessionId>.sock", () => {
  conn.write(JSON.stringify({ message: "What files changed today?" }) + "\n");
});
conn.on("data", (data) => {
  console.log(data.toString());
  conn.end();
});
```

### From Python

```python
import socket, json

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("/tmp/pi-rpc-sockets/<sessionId>.sock")
sock.sendall(json.dumps({"message": "List open TODOs"}).encode() + b"\n")
print(sock.recv(4096).decode())
sock.close()
```

## Delivery semantics

Messages are delivered with `deliverAs: "steer"`:
- If the agent is idle, the message triggers an LLM turn immediately.
- If the agent is mid-stream, the message queues until the current tool calls finish, then gets delivered before the next LLM call.

Messages appear with `source: "extension"` so downstream code can distinguish them from typed input.

## Install

```bash
# From the myagent repo root:
./install.sh

# Or for development:
pi -e ./extensions/rpc-socket/
```
