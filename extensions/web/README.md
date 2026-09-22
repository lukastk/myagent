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

# Or for development:
pi -e ./extensions/web/
```

## Dependencies

puppeteer, turndown, @mozilla/readability, linkedom, markit-ai, sharp, lru-cache
