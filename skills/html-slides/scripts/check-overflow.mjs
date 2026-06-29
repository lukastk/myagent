#!/usr/bin/env node
// Headless overflow check for a deck built from this skill's template.
// Loads the HTML, walks every slide, and reports which ones overflow the
// 16:9 stage (i.e. which ones rely on the y-scrollbar).
//
//   node check-overflow.mjs <path-to-presentation.html>
//
// Resolves Playwright from the patched MCP install at ~/.local/playwright-mcp.
// If that is missing, drive the file with the Playwright MCP browser tools
// instead (navigate to file://… then evaluate `window.slideOverflow()`).

import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('usage: node check-overflow.mjs <path-to-presentation.html>');
  process.exit(2);
}

const candidates = [
  path.join(homedir(), '.local/playwright-mcp/node_modules/playwright/index.js'),
  path.join(homedir(), '.local/playwright-mcp/node_modules/playwright-core/index.js'),
  'playwright',
  'playwright-core',
];
let chromium;
for (const c of candidates) {
  try {
    const mod = await import(c);
    chromium = mod.chromium ?? mod.default?.chromium;
    if (chromium) break;
  } catch { /* try next */ }
}
if (!chromium) {
  console.error('Playwright not found. Use the Playwright MCP browser tools instead:');
  console.error('  browser_navigate file://' + path.resolve(file));
  console.error('  browser_evaluate () => window.slideOverflow()');
  process.exit(3);
}

// Playwright doesn't ship a browser binary in this install (the MCP uses the
// system Brave), so find a Chromium-family executable to launch headless.
function findBrowser() {
  const fromEnv = process.env.BRAVE_CDP_BRAVE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ['brave-browser', 'brave', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { return execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { /* not on PATH */ }
  }
  return null;
}
const executablePath = findBrowser();
const launchOpts = { args: ['--no-sandbox'] };
if (executablePath) launchOpts.executablePath = executablePath;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(pathToFileURL(path.resolve(file)).href);
await page.waitForLoadState('networkidle').catch(() => {});

const count = await page.evaluate(() => document.querySelectorAll('.slide').length);
// Visit each slide so its content is laid out, then collect the report.
for (let n = 1; n <= count; n++) {
  await page.evaluate((k) => window.show?.(k - 1) ?? (location.hash = k), n);
  await page.waitForTimeout(40);
}
const report = await page.evaluate(() => window.slideOverflow());
await browser.close();

if (!report.length) {
  console.log(`✓ ${count} slides — none overflow.`);
} else {
  console.log(`⚠ ${report.length}/${count} slide(s) overflow (will y-scroll):`);
  for (const r of report) {
    console.log(`  slide ${r.index}: content ${r.scrollHeight}px vs ${r.clientHeight}px available`);
  }
}
process.exit(0);
