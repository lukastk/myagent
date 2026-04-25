/**
 * URL helper utilities for the fetch pipeline.
 * Extracted from oh-my-pi fetch.ts.
 */
import * as path from "node:path";
import { parseHTML } from "linkedom";
import { loadPage, looksLikeHtml } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

export const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.ms-powerpoint",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/rtf",
	"application/epub+zip",
	"application/x-ipynb+json",
	"application/zip",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
]);

export const CONVERTIBLE_EXTENSIONS = new Set([
	".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
	".rtf", ".epub", ".ipynb",
	".png", ".jpg", ".jpeg", ".gif", ".webp",
	".mp3", ".wav", ".ogg",
]);

export const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);

export const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

// =============================================================================
// URL utilities
// =============================================================================

/**
 * Normalize URL (add scheme if missing)
 */
export function normalizeUrl(url: string): string {
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

/**
 * Normalize MIME type (lowercase, strip charset/params)
 */
export function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Get extension from URL or Content-Disposition
 */
export function getExtensionHint(url: string, contentDisposition?: string): string {
	// Try Content-Disposition filename first
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = path.extname(match[1]).toLowerCase();
			if (ext) return ext;
		}
	}

	// Fall back to URL path
	try {
		const pathname = new URL(url).pathname;
		const ext = path.extname(pathname).toLowerCase();
		if (ext) return ext;
	} catch {}

	return "";
}

/**
 * Check if content type is convertible via markit.
 */
export function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

export function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

export function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

// =============================================================================
// LLM endpoints
// =============================================================================

/**
 * Build llms.txt candidates scoped to the requested URL
 */
export function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
		}

		const trimmedPath = parsed.pathname.replace(/\/+$/, "");
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];

		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
		}

		return endpoints;
	} catch {
		return [];
	}
}

/**
 * Try fetching URL with .md appended (llms.txt convention)
 */
export async function tryMdSuffix(url: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const candidates: string[] = [];

	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		if (pathname.endsWith("/")) {
			candidates.push(`${parsed.origin}${pathname}index.html.md`);
		} else if (pathname.includes(".")) {
			candidates.push(`${parsed.origin}${pathname}.md`);
		} else {
			candidates.push(`${parsed.origin}${pathname}.md`);
		}
	} catch {
		return null;
	}

	if (signal?.aborted) return null;

	for (const candidate of candidates) {
		if (signal?.aborted) return null;
		const result = await loadPage(candidate, { timeout, signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return result.content;
		}
	}

	return null;
}

/**
 * Try to fetch LLM-friendly endpoints
 */
export async function tryLlmEndpoints(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; endpoint: string } | null> {
	const endpoints = buildLlmEndpointCandidates(url);

	if (signal?.aborted || endpoints.length === 0) return null;

	for (const endpoint of endpoints) {
		if (signal?.aborted) return null;
		const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5), signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return { content: result.content, endpoint };
		}
	}
	return null;
}

/**
 * Try content negotiation for markdown/plain
 */
export async function tryContentNegotiation(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; type: string } | null> {
	if (signal?.aborted) return null;

	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
		signal,
	});

	if (!result.ok) return null;

	const mime = normalizeMime(result.contentType);
	if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
		return { content: result.content, type: result.contentType };
	}

	return null;
}

// =============================================================================
// HTML parsing helpers
// =============================================================================

/**
 * Read a single HTML attribute from a tag string
 */
function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Extract bounded <head> markup to avoid expensive whole-page parsing
 */
function extractHeadHtml(html: string): string {
	const lower = html.toLowerCase();
	const headStart = lower.indexOf("<head");
	if (headStart === -1) {
		return html.slice(0, 32 * 1024);
	}

	const headTagEnd = html.indexOf(">", headStart);
	if (headTagEnd === -1) {
		return html.slice(headStart, headStart + 32 * 1024);
	}

	const headEnd = lower.indexOf("</head>", headTagEnd + 1);
	const fallbackEnd = Math.min(html.length, headTagEnd + 1 + 32 * 1024);
	return html.slice(headStart, headEnd === -1 ? fallbackEnd : headEnd + 7);
}

/**
 * Parse alternate links from HTML head
 */
export function parseAlternateLinks(html: string, pageUrl: string): string[] {
	const links: string[] = [];

	try {
		const pagePath = new URL(pageUrl).pathname;
		const headHtml = extractHeadHtml(html);
		const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

		for (const tag of linkTags) {
			const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
			const relTokens = rel.split(/\s+/).filter(Boolean);
			if (!relTokens.includes("alternate")) continue;

			const href = getHtmlAttribute(tag, "href");
			const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
			if (!href) continue;

			// Skip site-wide feeds
			if (
				href.includes("RecentChanges") ||
				href.includes("Special:") ||
				href.includes("/feed/") ||
				href.includes("action=feed")
			) {
				continue;
			}

			if (type.includes("markdown")) {
				links.push(href);
			} else if (
				(type.includes("rss") || type.includes("atom") || type.includes("feed")) &&
				(href.includes(pagePath) || href.includes("comments"))
			) {
				links.push(href);
			}
		}
	} catch {}

	return links;
}

/**
 * Extract document links from HTML (for PDF/DOCX wrapper pages)
 */
export function extractDocumentLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();

	try {
		const anchorTags = html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? [];
		for (const tag of anchorTags) {
			const href = getHtmlAttribute(tag, "href");
			if (!href) continue;

			const ext = path.extname(href).toLowerCase();
			if (!CONVERTIBLE_EXTENSIONS.has(ext)) continue;

			const resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			links.push(resolved);
			if (links.length >= 20) break;
		}
	} catch {}

	return links;
}

// =============================================================================
// Feed parsing
// =============================================================================

/**
 * Strip CDATA wrapper and clean text
 */
function cleanFeedText(text: string): string {
	return text
		.replace(/<!\[CDATA\[/g, "")
		.replace(/\]\]>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]+>/g, "") // Strip HTML tags
		.trim();
}

/**
 * Parse RSS/Atom feed to markdown
 */
export function parseFeedToMarkdown(content: string, maxItems = 10): string {
	try {
		const doc = parseHTML(content).document;

		// Try RSS
		const channel = doc.querySelector("channel");
		if (channel) {
			const title = cleanFeedText(channel.querySelector("title")?.text || "RSS Feed");
			const items = channel.querySelectorAll("item").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const item of items) {
				const itemTitle = cleanFeedText(item.querySelector("title")?.text || "Untitled");
				const link = cleanFeedText(item.querySelector("link")?.text || "");
				const pubDate = cleanFeedText(item.querySelector("pubDate")?.text || "");
				const desc = cleanFeedText(item.querySelector("description")?.text || "");

				md += `## ${itemTitle}\n`;
				if (pubDate) md += `*${pubDate}*\n\n`;
				if (desc) md += `${desc.slice(0, 500)}${desc.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}

		// Try Atom
		const feed = doc.querySelector("feed");
		if (feed) {
			const title = cleanFeedText(feed.querySelector("title")?.text || "Atom Feed");
			const entries = feed.querySelectorAll("entry").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const entry of entries) {
				const entryTitle = cleanFeedText(entry.querySelector("title")?.text || "Untitled");
				const link = entry.querySelector("link")?.getAttribute("href") || "";
				const updated = cleanFeedText(entry.querySelector("updated")?.text || "");
				const summary = cleanFeedText(
					entry.querySelector("summary")?.text || entry.querySelector("content")?.text || "",
				);

				md += `## ${entryTitle}\n`;
				if (updated) md += `*${updated}*\n\n`;
				if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}
	} catch {}

	return content; // Fall back to raw content
}

// =============================================================================
// JSON formatting
// =============================================================================

/**
 * Format JSON
 */
export function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}
