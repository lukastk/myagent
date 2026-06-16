#!/usr/bin/env node
// Eval JS in the Obsidian Android WebView over CDP (via `adb forward tcp:9222`).
// Usage: node cdp-eval.mjs '<js expression>'   (reads from argv or stdin)
// Returns the JSON-serialized result of the (awaited) expression.

const PORT = process.env.CDP_PORT || '9222';

async function pageWsUrl() {
  const res = await fetch(`http://localhost:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target found');
  return page.webSocketDebuggerUrl;
}

function evalOverCdp(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 30000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: ++id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, replMode: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timeout);
      ws.close();
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result;
      if (r.exceptionDetails) {
        return reject(new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
      }
      resolve(r.result.value);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timeout); reject(new Error('ws error: ' + (e.message || e))); });
  });
}

const expr = process.argv[2] || await new Promise(r => {
  let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s));
});
try {
  const url = await pageWsUrl();
  const val = await evalOverCdp(url, expr);
  console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
