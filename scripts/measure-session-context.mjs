#!/usr/bin/env node
// Controlled SDK request measurement, NOT a full installed/default Pi session.
// See docs/fresh-session-context.md. No model API, MCP, hooks, RPC, or tool calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
const profile = {
  profile: 'controlled-sdk-agents-local-hashline-web-codemode',
  isFullDefaultSession: false,
  isProviderBilling: false,
  limitations: [
    'Operational extensions and all MCP are excluded, not simulated. Not default-session totals.',
    'Measures the normalized SDK provider boundary, not an HTTP payload or provider token accounting.',
    'Character estimates use Unicode code points / 4; JSON sizes include JSON syntax.',
    'Installed skills are measured, not concurrently edited or undistributed source copies.',
    'Project trust is explicitly granted in memory; no trust record or live session is used.',
    'No Claude/Codex measurement, historical request baseline, or task-selected tool/skill loading.',
  ],
};
const allowedExtensions = ['agents-local', 'pi-hashline-edit', 'web'];
const probe = 'Measure this fresh context without calling tools.';
let phase = 'arguments';

class MeasurementError extends Error {}
function check(condition, message) {
  // Messages are fixed diagnostics, never interpolated private prompt/config contents.
  if (!condition) throw new MeasurementError(message);
}
function measure(text) {
  check(typeof text === 'string', 'Expected text');
  const characters = [...text].length;
  return { characters, utf8Bytes: Buffer.byteLength(text), estimatedTokensCharsDiv4: characters / 4 };
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function optionalJson(p) { return fs.existsSync(p) ? readJson(p) : {}; }
function sum(rows) {
  return Object.fromEntries(['characters', 'utf8Bytes', 'estimatedTokensCharsDiv4']
    .map(key => [key, rows.reduce((total, row) => total + row[key], 0)]));
}

async function worker(packageDir, agentDir, scratch, projects) {
  check(process.permission?.has('fs.write', scratch), 'Worker requires Node permissions');
  check(!process.permission.has('child'), 'Child processes must be forbidden');
  check(!process.permission.has('fs.write', agentDir), 'Real agent directory must be read-only');
  phase = 'SDK import';
  const sdk = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
  const ai = await import(pathToFileURL(path.join(packageDir, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
  check(typeof sdk.ModelRuntime?.create === 'function' && typeof ai.InMemoryCredentialStore === 'function',
    'Unsupported SDK: in-memory ModelRuntime API required');
  const version = readJson(path.join(packageDir, 'package.json')).version;
  const global = readJson(path.join(agentDir, 'settings.json'));
  const extensionPaths = allowedExtensions.map(name => path.join(agentDir, 'extensions', name, 'index.ts'));
  for (const p of extensionPaths) check(fs.existsSync(p), 'Required installed extension missing');
  const neutral = path.join(scratch, 'neutral');
  fs.mkdirSync(neutral);
  const reports = [];

  for (const cwd of [neutral, ...projects]) {
    phase = 'read-only resource discovery';
    check(fs.statSync(cwd).isDirectory(), 'Project directory missing');
    const project = optionalJson(path.join(cwd, '.pi/settings.json'));
    // Only discovery/tool-presentation settings are relevant. Never import provider, proxy,
    // credential-command or session storage settings. Preserve global/project merge semantics.
    const pick = settings => Object.fromEntries(['packages', 'extensions', 'skills', 'defaultTools', 'codemode']
      .filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
    const values = {
      global: JSON.stringify({ ...pick(global), defaultProjectTrust: 'always',
        defaultProvider: 'context-measure', defaultModel: 'deterministic',
        compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }),
      project: JSON.stringify(pick(project)),
    };
    const settingsManager = sdk.SettingsManager.fromStorage({
      withLock(scope, fn) {
        const next = fn(values[scope]);
        if (next !== undefined) values[scope] = next;
      },
    }, { projectTrusted: true });
    check(settingsManager.drainErrors().length === 0, 'Settings failed to load');
    const manager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager });
    // PI_OFFLINE prevents installation, but must not silently drop missing packages.
    for (const [scope, settings] of [['user', global], ['project', project]]) {
      for (const entry of settings.packages ?? []) {
        const source = typeof entry === 'string' ? entry : entry.source;
        // Version reconciliation of npm sources can require external npm commands. This
        // bounded profile supports already-installed git/local packages only.
        check(!source.startsWith('npm:'), 'npm package accounting unsupported in this profile');
        const installed = manager.getInstalledPath(source, scope);
        check(installed && fs.existsSync(installed), 'Configured package not installed');
      }
    }
    const discovered = await manager.resolve(async () => 'error');
    const installedExtensions = discovered.extensions.filter(item => item.enabled).map(item => item.path);
    for (const p of extensionPaths) {
      check(installedExtensions.some(candidate => fs.realpathSync(candidate) === fs.realpathSync(p)),
        'Required extension is not enabled in installed discovery');
    }
    const selectedRealPaths = new Set(extensionPaths.map(p => fs.realpathSync(p)));
    const excludedExtensions = installedExtensions.filter(p => !selectedRealPaths.has(fs.realpathSync(p)));
    let captured;
    let calls = 0;
    const fakeProvider = api => {
      api.on('tool_call', () => { throw new Error('Measurement must never execute tools'); });
      api.registerProvider('context-measure', {
        baseUrl: 'http://invalid.local', apiKey: 'fake-local-only', api: 'openai-completions',
        models: [{ id: 'deterministic', name: 'Deterministic measurement', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 16 }],
        streamSimple(model, context) {
          calls++;
          check(calls === 1, 'Exactly one provider request per fresh session required');
          captured = context;
          const stream = ai.createAssistantMessageEventStream();
          const message = { role: 'assistant', content: [{ type: 'text', text: 'done' }],
            api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'done', partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: 'done', partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
          return stream;
        },
      });
    };
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: extensionPaths,
      extensionFactories: [sdk.createCodemodeExtension(settingsManager.getSettings().codemode), fakeProvider],
    });
    phase = 'controlled extension load';
    await resourceLoader.reload();
    check(resourceLoader.getExtensions().errors.length === 0, 'Controlled extensions failed to load');
    check(resourceLoader.getSkills().diagnostics.every(d => d.type !== 'error'), 'Skill discovery errors');
    const skills = resourceLoader.getSkills().skills;
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });

    async function capture(prompt) {
      captured = undefined;
      calls = 0;
      const sessionManager = sdk.SessionManager.inMemory(cwd);
      const { session } = await sdk.createAgentSession({ cwd, agentDir: path.join(scratch, 'agent'),
        settingsManager, resourceLoader, modelRuntime, sessionManager, thinkingLevel: 'off' });
      try {
        await session.bindExtensions({});
        await session.setModel(session.modelRuntime.getModel('context-measure', 'deterministic'));
        await session.prompt(prompt);
        check(calls === 1 && captured, 'Fake provider did not receive exactly one request');
        check(sessionManager.getSessionFile() === undefined, 'Session must remain in memory');
        check(captured.messages[0].role === 'system' && Array.isArray(captured.messages[0].toolsAdded),
          'Unsupported SDK transcript shape: initial system toolsAdded required');
        check(captured.messages.length === 2 && captured.messages[1].role === 'user',
          'Fresh request must contain only system and user messages');
        check(!Object.hasOwn(captured, 'tools'), 'Unexpected top-level tools field');
        const systemText = ai.getCurrentSystemPrompt(captured.messages);
        const tools = ai.getCurrentTools(captured.messages);
        check(tools.some(t => t.name === 'codemode') && tools.some(t => t.name === 'web_search') &&
          tools.some(t => t.name === 'fetch') && tools.some(t => t.name === 'read'), 'Required declarations absent');
        check(!tools.some(t => t.name === 'browser' || t.name === 'mcp' || t.name.startsWith('playwright')), 'Excluded tool leaked');
        const user = captured.messages[1].content;
        const userText = typeof user === 'string' ? user : user.map(c => {
          check(c.type === 'text', 'Unexpected non-text user block'); return c.text;
        }).join('');
        const components = { systemText: measure(systemText), toolDeclarationsJson: measure(JSON.stringify(tools)),
          userText: measure(userText) };
        return { systemText, userText, report: {
          components, componentSum: sum(Object.values(components)),
          normalizedRequestJson: measure(JSON.stringify(captured)),
          messages: captured.messages.map(m => m.role),
          tools: tools.map(t => ({ name: t.name, ...measure(JSON.stringify(t)) })),
        } };
      } finally {
        session.dispose();
      }
    }
    phase = 'fresh provider request';
    const initial = await capture(probe);
    check(initial.userText === probe, 'Initial user message must remain the fixed probe');
    const catalogue = sdk.formatSkillsForPrompt(skills).trim();
    check(initial.systemText.includes(catalogue), 'SDK skill catalogue missing from actual request');
    const contextFiles = resourceLoader.getAgentsFiles().agentsFiles.map(file => {
      check(initial.systemText.includes(file.content), 'Discovered instruction missing from actual request');
      return { path: file.path, ...measure(file.content) };
    });
    // Observe the actual read-only agents-local extension's nearest-AGENTS rule.
    let localMemory = null;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'AGENTS.md'))) {
        const p = path.join(dir, 'AGENTS.local.md');
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8').trim();
          check(!content || initial.systemText.includes(content), 'Local memory missing from request');
          localMemory = { path: p, ...measure(content) };
        }
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    phase = 'fresh explicit skill requests';
    const skillReports = [];
    for (const skill of skills) {
      const source = fs.readFileSync(skill.filePath, 'utf8');
      const explicit = await capture(`/skill:${skill.name} ${probe}`);
      check(explicit.userText !== probe && explicit.userText.includes('<skill'), 'Skill command did not expand');
      check(explicit.systemText === initial.systemText, 'Explicit skill changed system context unexpectedly');
      skillReports.push({ name: skill.name, path: skill.filePath,
        advertised: !skill.disableModelInvocation, sourceFile: measure(source),
        expandedUserMessage: explicit.report.components.userText,
        incrementalCharactersVsNeutralPrompt: explicit.report.components.userText.characters - [...probe].length,
        incrementalEstimatedTokensCharsDiv4: (explicit.report.components.userText.characters - [...probe].length) / 4 });
    }
    reports.push({ ...profile, piVersion: version, cwd, installedAgentDir: agentDir,
      includedExtensions: extensionPaths, includedNativeExtensions: ['codemode'],
      excludedExtensions, excludedNativeExtensions: ['mcp', 'tool-search', 'llama.cpp'],
      excludedResourceKinds: ['MCP configuration/transports/cache', 'extension-provided dynamic resources', 'prompt templates', 'themes'],
      instructionSources: contextFiles, localMemory,
      skillCatalogueInActualSystemText: measure(catalogue),
      skillCounts: { discovered: skills.length, advertised: skills.filter(s => !s.disableModelInvocation).length,
        manualOnly: skills.filter(s => s.disableModelInvocation).length, initiallyExpandedBodies: 0 },
      skillDiagnostics: resourceLoader.getSkills().diagnostics.map(d => ({ type: d.type, path: d.path })),
      skills: skillReports, initialRequest: initial.report,
      freshFakeProviderRequests: 1 + skills.length,
      guards: { hostFilesystemReadOnly: true, networkNamespaceIsolated: true,
        nodeChildProcessesForbidden: true, cleanEnvironment: true, credentialsAndSessionsInMemory: true,
        realAuthAndModelsNotLoaded: true, noToolCalls: true },
    });
  }
  return reports;
}

async function main() {
  if (process.argv[2] === '--worker') {
    const [packageDir, agentDir, scratch, ...projects] = process.argv.slice(3);
    const reports = await worker(packageDir, agentDir, scratch, projects);
    process.stdout.write(JSON.stringify(reports));
    return;
  }
  const [packageDir, ...specifiedProjects] = process.argv.slice(2);
  if (!packageDir || packageDir === '--help') {
    console.log('Usage: node scripts/measure-session-context.mjs /absolute/pi-coding-agent [absolute/project ...]');
    console.log('Linux + bubblewrap + Node permissions required. Defaults: neutral, myagent, sesh, myrig. Controlled profile only; NOT default-session totals or billing.');
    process.exitCode = packageDir === '--help' ? 0 : 1;
    return;
  }
  check(path.isAbsolute(packageDir), 'Pass an absolute Pi package path');
  check(process.platform === 'linux', 'This fail-closed sandbox requires Linux/bubblewrap');
  const home = os.homedir();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi/agent');
  check(path.isAbsolute(agentDir), 'Agent directory must be absolute');
  const projects = specifiedProjects.length ? specifiedProjects : [repo, path.join(repo, '../sesh'), path.join(repo, '../myrig')];
  check(projects.every(p => path.isAbsolute(p)), 'Project paths must be absolute');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-session-context-'));
  try {
    phase = 'sandboxed worker';
    const result = spawnSync('bwrap', ['--die-with-parent', '--unshare-net', '--unshare-pid',
      '--ro-bind', '/', '/', '--bind', scratch, scratch, '--proc', '/proc', '--dev', '/dev',
      '--chdir', scratch, '--', process.execPath, '--permission', '--allow-fs-read=/',
      `--allow-fs-write=${scratch}`, '--allow-addons', script, '--worker', packageDir, agentDir, scratch, ...projects], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch,
        XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache'),
        PI_CODING_AGENT_DIR: path.join(scratch, 'agent'), PI_OFFLINE: '1', JITI_CACHE_DIR: path.join(scratch, 'jiti') },
    });
    if (result.status !== 0) {
      // Never relay third-party logs, stack traces or assertion payloads containing prompts.
      const safePhase = result.stderr?.match(/MEASUREMENT_FAILED_PHASE:([A-Za-z -]+)\n/)?.[1];
      throw new MeasurementError(`Controlled SDK measurement failed${safePhase ? ` during ${safePhase}` : ''}; no report emitted (exit ${result.status}, signal ${result.signal}, stderr bytes ${Buffer.byteLength(result.stderr ?? '')}).`);
    }
    const reports = JSON.parse(result.stdout);
    check(reports.every(r => r.isFullDefaultSession === false && r.isProviderBilling === false), 'Report labels missing');
    console.log(JSON.stringify(reports, null, 2));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  if (process.argv[2] === '--worker') console.error(`MEASUREMENT_FAILED_PHASE:${phase}`);
  else console.error(error instanceof MeasurementError ? error.message : `Controlled SDK measurement failed during ${phase}; private diagnostics suppressed.`);
  process.exitCode = 1;
});
