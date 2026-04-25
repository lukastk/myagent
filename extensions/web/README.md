# Web Tools Extension

Three tools for Pi: **web search**, **URL fetch**, and **browser automation**. Transplanted from [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Tools

### `web_search`

Searches the web using whichever provider has an API key configured. Providers are tried in fallback order — if one fails, the next is attempted automatically.

**Parameters:**
- `query` (required) — search query
- `recency` — filter: `day`, `week`, `month`, `year`
- `limit` — max results to return
- `max_tokens` — max output tokens
- `temperature` — sampling temperature (0-1)

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
| `/search-provider [name\|auto]` | Set preferred search provider |
| `/browser [visible\|headless]` | Toggle browser headed/headless mode |

## Search Providers

Set the corresponding env var to enable a provider. The fallback order is listed below — the first available provider is used.

| Priority | Provider | Env Var |
|---|---|---|
| 1 | Tavily | `TAVILY_API_KEY` |
| 2 | Perplexity | `PERPLEXITY_API_KEY` |
| 3 | Brave | `BRAVE_API_KEY` |
| 4 | Jina | `JINA_API_KEY` |
| 5 | Kimi | `KIMI_SEARCH_API_KEY` or `MOONSHOT_SEARCH_API_KEY` |
| 6 | Anthropic | `ANTHROPIC_API_KEY` |
| 7 | Gemini | `GEMINI_API_KEY` |
| 8 | Codex (OpenAI) | `OPENAI_API_KEY` |
| 9 | Z.AI | `ZAI_API_KEY` |
| 10 | Exa | `EXA_API_KEY` |
| 11 | Parallel | `PARALLEL_API_KEY` |
| 12 | Kagi | `KAGI_API_KEY` |
| 13 | Synthetic | `SYNTHETIC_API_KEY` |

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
