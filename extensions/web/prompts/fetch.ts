/**
 * Fetch tool prompt — injected into the system prompt.
 */
export const FETCH_TOOL_PROMPT = `## fetch tool

The \`fetch\` tool fetches a URL and returns clean extracted text/markdown content. It is multi-purpose:

- **HTML pages**: Extracts main content in reader-mode markdown. Tries multiple rendering methods (Jina, trafilatura, lynx, built-in converter).
- **Known sites**: Has 76+ site-specific extractors for GitHub (issues, PRs, repos, gists), Stack Overflow, Wikipedia, Reddit, Hacker News, NPM, PyPI, crates.io, arXiv, YouTube (metadata + transcript), Bluesky, Mastodon, Docker Hub, MDN, and many more.
- **Documents**: Converts PDFs, DOCX, PPTX, XLSX, EPUB, and other document formats to text via markit.
- **Images**: Fetches and resizes images for inline display, with optional OCR/description via markit.
- **JSON**: Pretty-prints JSON responses.
- **RSS/Atom feeds**: Parses feeds into markdown listings.
- **LLM-friendly endpoints**: Checks for llms.txt, .md suffixes, and content negotiation.

### Parameters
- \`url\` (required): The URL to fetch
- \`timeout\` (optional): Timeout in seconds (default 20, max 120)
- \`raw\` (optional): If true, returns raw content without special handling or reader-mode extraction

### Usage notes
- Prefer \`fetch\` over browser tools for static web content
- Use \`raw: true\` only when you need the original HTML/response
- The tool handles redirects, bot detection (tries multiple user agents), and size limits automatically
`;
