# Web Tools Extension

Three tools for Pi: **web search**, **URL fetch**, and **browser automation**. Transplanted from [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Tools

### `web_search`

Searches the web using the session's preferred provider, which defaults to Brave. Only `provider: "auto"` (or `/search-provider auto`) uses the configured fallback chain; selecting a specific provider does not silently fall back to another one.

**Parameters:**
- `query` (required) — search query
- `provider` — provider for this call: `auto`, `brave`, `exa`, `parallel`, `tinyfish`, `kagi`, `you`, `synthetic`, `jina`, `kimi`, `zai`, `tavily`, `perplexity`, `anthropic`, `gemini`, or `codex`; omit it to use the session preference (initially `brave`)
- `recency` — filter: `day`, `week`, `month`, `year`
- `limit` — max results to return
- `max_tokens` — max output tokens
- `temperature` — sampling temperature (0-1)
- `num_search_results` — number of search results to retrieve

### `fetch`

Fetches and extracts content from URLs. Includes 76 site-specific scrapers for optimal extraction, plus a general HTML-to-markdown pipeline with multiple fallback methods.

**Parameters:**
- `url` (required) — URL to fetch
- `timeout` — timeout in seconds (default 20)
- `raw` — skip special handlers, return raw content

**Site-specific scrapers:** GitHub, GitLab, npm, PyPI, crates.io, Docker Hub, Stack Overflow, Wikipedia, arXiv, Reddit, Hacker News, YouTube, Spotify, MDN, and 60+ more.

**HTML rendering chain:** Jina Reader API, trafilatura, lynx, Turndown (in fallback order).

**Also handles:** PDF, DOCX, PPTX, XLSX, EPUB, images, audio (via markit-ai), RSS/Atom feeds, JSON, llms.txt discovery.

### `browser`

Headless browser automation via Puppeteer with 14 anti-detection stealth scripts.

This alternate browser is **deferred**, not declared in every model request.
Find it via `searchTools("Puppeteer")` in Pi's codemode and inspect/call the
returned tool. Prefer Playwright MCP for normal browsing and the user's
Brave profile; Puppeteer does not share that profile. `/browser` still
controls its headed/headless mode. Session shutdown releases the browser.

Search and fetch remain directly exposed. The research system prompt is
passed to search-provider requests only; the extension does not inject a
research persona into the parent coding agent.

**Actions:** `open`, `goto`, `observe`, `click`, `click_id`, `type`, `type_id`, `fill`, `fill_id`, `press`, `scroll`, `drag`, `wait_for_selector`, `evaluate`, `get_text`, `get_html`, `get_attribute`, `extract_readable`, `screenshot`, `close`

**Key features:**
- Accessibility tree snapshots via `observe` (preferred over screenshots)
- Element caching with numeric IDs for efficient interaction
- Headed/headless toggle at runtime
- Screenshot compression (max 1024x1024, 150KB, JPEG quality 70)
- User agent override with Client Hints
- NixOS Chromium detection

## Slash Commands

| Command | Description |
|---|---|
| `/search-provider [name\|auto]` | Open provider picker when run without args; set provider directly when name/auto is passed |
| `/browser [visible\|headless]` | Toggle browser headed/headless mode |

## Search Providers

Environment variables enable providers directly. On mysetup machines, the extension also discovers matching entries through `secret list` and retrieves them on demand with `secret get` at the first search. Retrieved values remain inside the extension and are not exported to Pi or its child processes.

| Priority | Provider | Credential names |
|---|---|---|
| 1 | Brave | `BRAVE_API_KEY` |
| 2 | Exa | `EXA_API_KEY` |
| 3 | Parallel | `PARALLEL_API_KEY` |
| 4 | TinyFish | `TINYFISH_API_KEY` |
| 5 | Kagi | `KAGI_API_KEY` |
| 6 | You.com | `YDC_API_KEY` |
| 7 | Synthetic | `SYNTHETIC_API_KEY` |
| 8 | Jina | `JINA_API_KEY` |
| 9 | Kimi | `KIMI_SEARCH_API_KEY` or `MOONSHOT_SEARCH_API_KEY` |
| 10 | Z.AI | `ZAI_API_KEY` |
| 11 | Tavily | `TAVILY_API_KEY` |
| 12 | Perplexity | `PERPLEXITY_API_KEY` |
| 13 | Anthropic | `ANTHROPIC_API_KEY` or `MY_ANTHROPIC_API_KEY` |
| 14 | Gemini | `GEMINI_API_KEY` |
| 15 | Codex (OpenAI) | `OPENAI_API_KEY` or `MY_OPENAI_API_KEY` |

The automatic order favors source-result APIs. In particular, Exa requests query-relevant highlights rather than generated per-page summaries; Perplexity, Anthropic, Gemini, and Codex remain answer-synthesis fallbacks.

If `secret` is not installed, search remains environment-only. Failures from an installed `secret` command are surfaced rather than silently treating a broken vault lookup as missing credentials.

## Other Env Vars

| Var | Used By |
|---|---|
| `GITHUB_TOKEN` | GitHub scraper (fetch tool) — for API rate limits |
| `BROWSER_SCREENSHOT_DIR` | Browser tool — auto-save screenshots to this directory |
| `PUPPETEER_PROXY` | Browser tool — HTTP proxy |
| `ANTHROPIC_SEARCH_MODEL` | Anthropic search provider — override model (default: `claude-haiku-4-5`) |

## Install

```bash
# From the myagent repo root:
./install.sh

# Only this extension's dependencies (no other clients/configuration):
bash scripts/install-web-dependencies.sh extensions/web

# Or load the already-installed extension for development:
pi -e ./extensions/web/
```

## Dependencies

puppeteer, turndown, @mozilla/readability, linkedom, markit-ai, sharp, lru-cache

### Termux / Android native image support

Sharp 0.33.5 has no Android prebuilt binary. Its import is shared by fetch and
browser image handling, so a missing native build prevents the **whole extension**
from loading, including text tools. Do not catch/ignore that import or substitute
an image fallback.

The normal Pi installer routes this extension through
[`scripts/install-web-dependencies.sh`](../../scripts/install-web-dependencies.sh).
On Android that helper:

1. Requires Termux's `PREFIX` and installed Node headers.
2. Installs `libvips clang make python pkg-config` with
   `apt-get install -y --no-upgrade` (no general update/upgrade). Apt may need
   related dependency revisions; it is not a promise of zero dependency changes.
3. Installs the declared npm dependencies with `--omit=dev`, using Termux's patched
   headers through `npm_package_config_node_gyp_nodedir="$PREFIX"`. Upstream Node
   headers target an Android NDK cross-build, not Termux's native toolchain.
4. Explicitly rebuilds Sharp against system libvips. This also repairs an existing
   npm tree whose original Sharp install succeeded without producing a binary;
   plain `npm install` does not rerun that dependency's install hook.
5. Imports Sharp and performs a PNG encode/resize/decode probe. A successful npm
   exit alone is insufficient: Sharp 0.33 can skip its build when prerequisites
   are missing. Any provisioning, build or image-probe failure stops installation.

Other platforms keep the ordinary npm install path plus the image probe; no apt
commands or forced rebuilds run there. No image/runtime code was changed.

**Build dependencies are production dependencies** because the installer omits
dev dependencies. `node-addon-api` is pinned to **7.1.1**, compatible with Sharp
0.33's C++11 build and its documented minimum of version 7. A trial with 8.9.2
failed on C++17-only types (`std::void_t`, etc.); do not float that dependency to
8.x without retesting/updating Sharp's build contract. `node-gyp` 12.4.0 was
tested with Termux Python 3.14.6 and Node 26.4.0. Sharp itself stays at 0.33.5;
the lockfile addition does not upgrade existing dependency entries.

References: [Sharp 0.33.5 source-build requirements](https://github.com/lovell/sharp/blob/v0.33.5/docs/install.md#building-from-source),
[Termux libvips package](https://github.com/termux/termux-packages/blob/master/packages/libvips/build.sh),
[Termux Node header configuration](https://github.com/termux/termux-packages/blob/master/packages/nodejs/build.sh).

### Targeted validation

```bash
# Hermetic installer routing, platform isolation, argv and failure tests:
python3 scripts/test-install-web-dependencies.py
# Real shared image helper: PNG/JPEG/WebP, alpha fast path, byte pressure, SVG, errors.
# Requires Node >=22.18 for native TypeScript stripping; no browser/network/credentials.
node --test extensions/web/test-images.mjs
# Real installed Pi SDK: actual extension load, tool registration and codemode call.
# Leave optional CONTEXT_TEST_* browser-smoke variables unset.
node scripts/test-context-exposure.mjs "$(npm root -g)/@earendil-works/pi-coding-agent"
```

Verified 2026-10-07 on Termux: Pi 0.99.1, Node 26.4.0, Sharp 0.33.5, system libvips
8.18.7. Native import, all seven image tests and the existing SDK exposure test
passed without a browser launch, credentials, client reload or API request.
The initial libvips provision added 24 packages and upgraded the related libjxl
revision (0.12.0 → 0.12.0-1); unrelated pending upgrades were left untouched.
