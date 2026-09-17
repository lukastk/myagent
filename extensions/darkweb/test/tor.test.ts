import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { DarkwebError } from "../lib/core.ts";
import { onionFetch } from "../lib/tor.ts";

const ONION = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion";

type Responder = (socket: Socket, request: string) => void;

async function fakeSocks(responder: Responder): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let state: "greeting" | "auth" | "connect" | "http" = "greeting";
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        if (state === "greeting") {
          if (buffered.length < 2 + (buffered[1] ?? 0)) return;
          buffered = buffered.subarray(2 + buffered[1]);
          socket.write(Buffer.from([0x05, 0x02]));
          state = "auth";
        } else if (state === "auth") {
          if (buffered.length < 2) return;
          const userLength = buffered[1];
          if (buffered.length < 3 + userLength) return;
          const passwordLength = buffered[2 + userLength];
          const length = 3 + userLength + passwordLength;
          if (buffered.length < length) return;
          buffered = buffered.subarray(length);
          socket.write(Buffer.from([0x01, 0x00]));
          state = "connect";
        } else if (state === "connect") {
          if (buffered.length < 5) return;
          const addressType = buffered[3];
          const addressLength = addressType === 0x03 ? 1 + buffered[4] : addressType === 0x01 ? 4 : 16;
          const length = 4 + addressLength + 2;
          if (buffered.length < length) return;
          buffered = buffered.subarray(length);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x23, 0x28]));
          state = "http";
        } else {
          const end = buffered.indexOf("\r\n\r\n");
          if (end < 0) return;
          const request = buffered.subarray(0, end + 4).toString("ascii");
          buffered = buffered.subarray(end + 4);
          responder(socket, request);
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function httpResponse(status: string, headers: Record<string, string>, body = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    Buffer.from(
      [`HTTP/1.1 ${status}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n"),
      "ascii",
    ),
    body,
  ]);
}

async function withEnvironment(responder: Responder, run: (auditPath: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "darkweb-test-"));
  const auditPath = join(root, "audit.jsonl");
  const socks = await fakeSocks(responder);
  const oldProxy = process.env.MYAGENT_TOR_SOCKS_URL;
  const oldAudit = process.env.MYAGENT_DARKWEB_AUDIT_LOG;
  process.env.MYAGENT_TOR_SOCKS_URL = `socks5h://127.0.0.1:${socks.port}`;
  process.env.MYAGENT_DARKWEB_AUDIT_LOG = auditPath;
  try {
    await run(auditPath);
  } finally {
    if (oldProxy === undefined) delete process.env.MYAGENT_TOR_SOCKS_URL;
    else process.env.MYAGENT_TOR_SOCKS_URL = oldProxy;
    if (oldAudit === undefined) delete process.env.MYAGENT_DARKWEB_AUDIT_LOG;
    else process.env.MYAGENT_DARKWEB_AUDIT_LOG = oldAudit;
    await socks.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("fetches sanitized HTML and retains only same-onion links", { concurrency: false }, async () => {
  const body = Buffer.from(`<!doctype html><title> Safe title </title><body>Hello <script>ignore()</script><form>secret</form><a href="/next#part">Next</a><a href="https://example.com/">Clear</a></body>`);
  await withEnvironment(
    (socket) => socket.end(httpResponse("200 OK", { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.length) }, body)),
    async (auditPath) => {
      const result = await onionFetch({ url: `http://${ONION}/`, timeout_ms: 5_000, max_bytes: 65_536 });
      assert.equal(result.title, "Safe title");
      assert.equal(result.text, "Hello Next Clear");
      assert.deepEqual(result.same_onion_links, [`http://${ONION}/next`]);
      const audit = await readFile(auditPath, "utf8");
      assert.doesNotMatch(audit, new RegExp(ONION));
      assert.match(audit, /"outcome":"success"/);
    },
  );
});

test("blocks a redirect to the clearnet and audits the failure", { concurrency: false }, async () => {
  await withEnvironment(
    (socket) => socket.end(httpResponse("302 Found", { Location: "https://example.com/", "Content-Length": "0" })),
    async (auditPath) => {
      await assert.rejects(() => onionFetch({ url: `http://${ONION}/`, timeout_ms: 5_000, max_bytes: 65_536 }), (error: unknown) => {
        assert.ok(error instanceof DarkwebError);
        assert.equal(error.code, "REDIRECT_BLOCKED");
        return true;
      });
      assert.match(await readFile(auditPath, "utf8"), /REDIRECT_BLOCKED/);
    },
  );
});

test("blocks unsupported MIME types", { concurrency: false }, async () => {
  const body = Buffer.from("binary");
  await withEnvironment(
    (socket) => socket.end(httpResponse("200 OK", { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) }, body)),
    async () => {
      await assert.rejects(() => onionFetch({ url: `http://${ONION}/`, timeout_ms: 5_000, max_bytes: 65_536 }), (error: unknown) => {
        assert.ok(error instanceof DarkwebError);
        assert.equal(error.code, "CONTENT_TYPE_BLOCKED");
        return true;
      });
    },
  );
});

test("blocks compressed content that expands beyond the response cap", { concurrency: false }, async () => {
  const body = gzipSync(Buffer.alloc(70_000, 65));
  await withEnvironment(
    (socket) => socket.end(httpResponse("200 OK", {
      "Content-Type": "text/plain",
      "Content-Encoding": "gzip",
      "Content-Length": String(body.length),
    }, body)),
    async () => {
      await assert.rejects(() => onionFetch({ url: `http://${ONION}/`, timeout_ms: 5_000, max_bytes: 65_536 }), (error: unknown) => {
        assert.ok(error instanceof DarkwebError);
        assert.equal(error.code, "RESPONSE_TOO_LARGE");
        return true;
      });
    },
  );
});

test("enforces an overall timeout", { concurrency: false }, async () => {
  await withEnvironment(
    () => {},
    async () => {
      await assert.rejects(() => onionFetch({ url: `http://${ONION}/`, timeout_ms: 5_000, max_bytes: 65_536 }), (error: unknown) => {
        assert.ok(error instanceof DarkwebError);
        assert.equal(error.code, "FETCH_TIMEOUT");
        return true;
      });
    },
  );
});
