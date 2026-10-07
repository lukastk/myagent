// Real Pi SDK + web extension + QuickJS, deterministic model: no paid API calls.
// Usage: node scripts/test-context-exposure.mjs /absolute/path/to/pi-coding-agent
// The explicit package path tests the actual host, not web's npm peer copy.
// Optional real isolated-Brave smoke test (no web requests): set both
// CONTEXT_TEST_MCP_ADAPTER=/absolute/path/to/adapter/index.ts and
// CONTEXT_TEST_PLAYWRIGHT_DIR=/absolute/path/to/.local/playwright-mcp.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const packageDir = process.argv[2];
assert(packageDir && path.isAbsolute(packageDir), 'Pass an absolute installed Pi package directory');
const adapter = process.env.CONTEXT_TEST_MCP_ADAPTER;
const playwrightDir = process.env.CONTEXT_TEST_PLAYWRIGHT_DIR;
if (adapter || playwrightDir) {
  assert(adapter && path.isAbsolute(adapter) && playwrightDir && path.isAbsolute(playwrightDir),
    'The MCP smoke test needs both absolute adapter and Playwright installation paths');
}
if (process.argv[3] !== 'isolated') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-context-'));
  try {
    const result = spawnSync(process.execPath, [script, packageDir, 'isolated'], {
      cwd: home, encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_OFFLINE: '1',
        ...(adapter ? { CONTEXT_TEST_MCP_ADAPTER: adapter, CONTEXT_TEST_PLAYWRIGHT_DIR: playwrightDir,
          PI_MCP_ADAPTER_TEST_AUTH_STORE: 'memory', PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: '1' } : {}) }, 
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assert.equal(result.status, 0, String(result.error ?? result.signal ?? result.stderr));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
} else {
  const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(
    path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(agentDir, { recursive: true });
  if (adapter) {
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'mcp.json'), 'utf8'));
    // Only local Playwright is included. Never connect to a user's window or remote worker.
    fs.writeFileSync(path.join(agentDir, 'mcp-adapter.json'), JSON.stringify({
      settings: config.settings,
      mcpServers: { playwright: { ...config.mcpServers.playwright, cwd: playwrightDir,
        env: { BRAVE_CDP_CLI: path.join(playwrightDir, 'node_modules/@playwright/mcp/cli.js'),
          BRAVE_CDP_HEADLESS: '1' } } },
    }));
  }
  let pi, pending;
  const requests = [];
  const modelExtension = api => {
    pi = api;
    api.registerProvider('context-test', {
      baseUrl: 'http://invalid.local', apiKey: 'local-test', api: 'openai-completions',
      models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      streamSimple(model, context) {
        requests.push(context);
        const call = pending;
        pending = undefined;
        const stream = createAssistantMessageEventStream();
        const message = { role: 'assistant',
          content: call ? [{ type: 'toolCall', id: `test-${requests.length}`, ...call }] : [{ type: 'text', text: 'done' }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: call ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    });
  };
  const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: ['+codemode'], defaultProjectTrust: 'always' });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: process.env.HOME, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [path.join(repo, 'extensions/web/index.ts'), ...(adapter ? [adapter] : [])],
    extensionFactories: [sdk.createCodemodeExtension(), modelExtension],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: process.env.HOME, agentDir, settingsManager, resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(process.env.HOME) });
  try {
    await session.bindExtensions({});
    await session.setModel(session.modelRuntime.getModel('context-test', 'test'));
    await session.prompt('Inspect the initial context.');
    assert.equal(requests.length, 1, 'The deterministic provider must handle the request');
    assert(!JSON.stringify(requests[0]).includes('Research assistant with web search capabilities'));
    assert(!JSON.stringify(requests[0]).includes('You **MUST** answer thoroughly and in detail'));
    assert(pi.getActiveTools().includes('fetch'));
    assert(pi.getActiveTools().includes('web_search'));
    assert(!pi.getActiveTools().includes('browser'));
    const browser = pi.getAllTools().find(t => t.name === 'browser');
    assert.equal(browser.exposure, 'deferred');
    assert(browser.description.includes('Puppeteer'));
    // Pi 1.x carries declarations in system-message deltas; 0.99 uses Context.tools.
    const version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
    const initialTools = Number(version.split('.')[0]) >= 1
      ? requests[0].messages[0].toolsAdded : requests[0].tools;
    assert(Array.isArray(initialTools), `Expected model-visible declarations on Pi ${version}`);
    assert(initialTools.some(t => t.name === 'fetch'));
    assert(initialTools.some(t => t.name === 'web_search'));
    assert(!initialTools.some(t => t.name === 'browser'), 'Browser schema leaked into the request');
    pending = { name: 'codemode', arguments: { code: `
      const found = await searchTools('Puppeteer');
      if (!found.some(t => t.name === 'browser')) throw Error('optional browser not discoverable');
      const definition = await describeTool('browser');
      if (!definition.includes('fetch') || definition.replaceAll(String.fromCharCode(96), '').includes('read tool with a URL')) throw Error('wrong URL tool guidance');
      await tools.browser({action:'close'}); // exercises the real tool without launching a browser
      text('optional browser callable');
    ` } };
    await session.prompt('Run the discovery assertion.');
    const results = session.messages.filter(m => m.role === 'toolResult');
    assert.equal(results.length, 1);
    assert(!results[0].isError, JSON.stringify(results[0]));
    assert(!pi.getActiveTools().includes('browser'), 'Codemode call must not eagerly promote the tool');
    console.log('PASS: no parent research persona; search/fetch direct; optional browser deferred, discoverable, callable');
    if (adapter) {
      assert(!initialTools.some(t => t.name.startsWith('playwright_')));
      pending = { name: 'mcp', arguments: { connect: 'playwright' } };
      await session.prompt('Connect the local fixture browser server.');
      const localTools = pi.getAllTools().filter(t => t.name.startsWith('playwright_'));
      assert(localTools.length > 0, 'Cold-cache explicit connect did not register tools');
      for (const tool of localTools) {
        assert.equal(tool.exposure, 'deferred');
        assert(!pi.getActiveTools().includes(tool.name));
      }
      pending = { name: 'codemode', arguments: { code: `
        const ns = {namespace:'mcp__playwright'};
        const navigate = (await searchTools('navigate',ns)).find(t=>t.name.endsWith('browser_navigate'));
        const close = (await searchTools('close',ns)).find(t=>t.name.endsWith('browser_close'));
        if (!navigate || !close) throw Error('Playwright discovery failed');
        try {
          const r = await tools[navigate.name]({url:'data:text/html,<h1>Context smoke</h1>'});
          if (r.isError || !JSON.stringify(r).includes('Context smoke')) throw Error(JSON.stringify(r));
        } finally {
          const r = await tools[close.name]({});
          if (r.isError) throw Error(JSON.stringify(r));
        }
        text('Playwright discovered, navigated, closed');
      ` } };
      await session.prompt('Run the local browser smoke test.');
      for (const result of session.messages.filter(m => m.role === 'toolResult')) {
        assert(!result.isError, JSON.stringify(result));
      }
      assert(!pi.getActiveTools().some(name => name.startsWith('playwright_')));
      console.log(`PASS: ${localTools.length} local Playwright tools deferred; cold connect, discovery, navigation, close`);
    }
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown' });
    session.dispose();
  }
}
