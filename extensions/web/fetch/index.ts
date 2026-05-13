/**
 * Fetch tool — fetches URLs and extracts clean text/markdown.
 * Supports 76 site-specific scrapers plus a general HTML rendering pipeline.
 */
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { ToolAbortError } from "../lib/errors.js";
import { formatDimensionNote, resizeImage } from "../lib/image-resize.js";
import { specialHandlers } from "../scrapers/index.js";
import type { RenderResult } from "./types.js";
import { finalizeOutput, loadPage, looksLikeHtml, MAX_OUTPUT_CHARS } from "./types.js";
import { fetchBinary, convertWithMarkit } from "./utils.js";
import { renderHtmlToText, isLowQualityOutput } from "./render-html.js";
import {
	normalizeUrl,
	normalizeMime,
	getExtensionHint,
	isConvertible,
	resolveImageMimeType,
	isInlineImageMimeTypeSupported,
	tryMdSuffix,
	tryLlmEndpoints,
	tryContentNegotiation,
	parseAlternateLinks,
	extractDocumentLinks,
	parseFeedToMarkdown,
	formatJson,
	MAX_INLINE_IMAGE_SOURCE_BYTES,
	MAX_INLINE_IMAGE_OUTPUT_BYTES,
} from "./url-helpers.js";

// =============================================================================
// Types
// =============================================================================

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
};

// =============================================================================
// Simple dedup cache
// =============================================================================

interface CacheEntry {
	result: FetchRenderResult;
	output: string;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(url: string, raw: boolean): string {
	return `${raw ? "raw" : "rendered"}::${normalizeUrl(url)}`;
}

// =============================================================================
// Special Handler Dispatch
// =============================================================================

async function handleSpecialUrls(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<FetchRenderResult | null> {
	for (const handler of specialHandlers) {
		if (signal?.aborted) throw new ToolAbortError();
		const result = await handler(url, timeout, signal);
		if (result) return result;
	}
	return null;
}

// =============================================================================
// Main Render Function
// =============================================================================

async function renderUrl(
	url: string,
	timeout: number,
	raw: boolean,
	signal?: AbortSignal,
): Promise<FetchRenderResult> {
	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();
	if (signal?.aborted) throw new ToolAbortError();

	// Step 0: Normalize URL
	url = normalizeUrl(url);

	// Step 1: Try special handlers for known sites (unless raw mode)
	if (!raw) {
		const specialResult = await handleSpecialUrls(url, timeout, signal);
		if (specialResult) return specialResult;
	}

	// Step 2: Fetch page
	const response = await loadPage(url, { timeout, signal });
	if (signal?.aborted) throw new ToolAbortError();
	if (!response.ok) {
		return {
			url,
			finalUrl: response.finalUrl || url,
			contentType: response.contentType || "unknown",
			method: "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes: [response.status ? `Failed to fetch URL (HTTP ${response.status})` : "Failed to fetch URL"],
		};
	}

	const { finalUrl, content: rawContent } = response;
	const mime = normalizeMime(response.contentType);
	const extHint = getExtensionHint(finalUrl);

	const imageMimeType = resolveImageMimeType(mime, extHint);
	let skipConvertibleBinaryRetry = false;
	if (imageMimeType) {
		if (!isInlineImageMimeTypeSupported(imageMimeType)) {
			notes.push(
				`Image MIME type ${imageMimeType} is unsupported for inline model serialization; returning text metadata only`,
			);
			const shouldTryConvertibleFallback = isConvertible(mime, extHint);
			if (shouldTryConvertibleFallback) {
				notes.push("Attempting binary conversion fallback for unsupported image MIME type");
			} else {
				notes.push("Falling back to textual rendering from initial response");
			}
			skipConvertibleBinaryRetry = !shouldTryConvertibleFallback;
		} else {
			const binary = await fetchBinary(finalUrl, timeout, signal);
			if (binary.ok) {
				notes.push("Fetched image binary");
				const conversionExtension = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
				let convertedText: string | null = null;
				const converted = await convertWithMarkit(binary.buffer, conversionExtension, timeout, signal);
				if (converted.ok) {
					if (converted.content.trim().length > 50) {
						notes.push("Converted with markit");
						convertedText = converted.content;
					} else {
						notes.push("markit conversion produced no usable output");
					}
				} else if (converted.error) {
					notes.push(`markit conversion failed: ${converted.error}`);
				} else {
					notes.push("markit conversion failed");
				}

				if (binary.buffer.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
					notes.push(
						`Image exceeds inline source limit (${binary.buffer.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						convertedText ?? `Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url, finalUrl, contentType: imageMimeType,
						method: convertedText ? "markit" : "image-too-large",
						content: output.content, fetchedAt, truncated: output.truncated, notes,
					};
				}

				const resized = await resizeImage(
					{ type: "image", data: Buffer.from(binary.buffer).toString("base64"), mimeType: imageMimeType },
					{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES },
				);
				const isDecodedImage =
					resized.originalWidth > 0 && resized.originalHeight > 0 && resized.width > 0 && resized.height > 0;
				if (!isDecodedImage) {
					notes.push(`Fetched payload could not be decoded as ${imageMimeType}; returning text metadata only`);
					const output = finalizeOutput(
						convertedText ??
							rawContent ??
							`Fetched payload was labeled ${imageMimeType}, but bytes were not a valid image.`,
					);
					return {
						url, finalUrl, contentType: imageMimeType,
						method: convertedText ? "markit" : "image-invalid",
						content: output.content, fetchedAt, truncated: output.truncated, notes,
					};
				}
				if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
					notes.push(
						`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						convertedText ?? `Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url, finalUrl, contentType: imageMimeType,
						method: convertedText ? "markit" : "image-too-large",
						content: output.content, fetchedAt, truncated: output.truncated, notes,
					};
				}

				const dimensionNote = formatDimensionNote(resized);
				let imageSummary = convertedText ?? `Fetched image content (${resized.mimeType}).`;
				if (dimensionNote) {
					imageSummary += `\n${dimensionNote}`;
				}
				const output = finalizeOutput(imageSummary);
				return {
					url, finalUrl, contentType: resized.mimeType, method: "image",
					content: output.content, fetchedAt, truncated: output.truncated, notes,
					image: { data: resized.data, mimeType: resized.mimeType },
				};
			}
			notes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		}
	}

	// Step 3: Handle convertible binary files (PDF, DOCX, etc.)
	if (!skipConvertibleBinaryRetry && isConvertible(mime, extHint)) {
		const binary = await fetchBinary(finalUrl, timeout, signal);
		if (binary.ok) {
			const ext = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
			const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
			if (converted.ok) {
				if (converted.content.trim().length > 50) {
					notes.push("Converted with markit");
					const output = finalizeOutput(converted.content);
					return {
						url, finalUrl, contentType: mime, method: "markit",
						content: output.content, fetchedAt, truncated: output.truncated, notes,
					};
				}
				notes.push("markit conversion produced no usable output");
			} else if (converted.error) {
				notes.push(`markit conversion failed: ${converted.error}`);
			} else {
				notes.push("markit conversion failed");
			}
		} else if (binary.error) {
			notes.push(`Binary fetch failed: ${binary.error}`);
		} else {
			notes.push("Binary fetch failed");
		}
	}

	// Step 4: Handle non-HTML text content
	const isHtml = mime.includes("html") || mime.includes("xhtml");
	const isJson = mime.includes("json");
	const isXml = mime.includes("xml") && !isHtml;
	const isText = mime.includes("text/plain") || mime.includes("text/markdown");
	const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");

	if (isJson) {
		const output = finalizeOutput(formatJson(rawContent));
		return {
			url, finalUrl, contentType: mime, method: "json",
			content: output.content, fetchedAt, truncated: output.truncated, notes,
		};
	}

	if (isFeed || (isXml && (rawContent.includes("<rss") || rawContent.includes("<feed")))) {
		const parsed = parseFeedToMarkdown(rawContent);
		const output = finalizeOutput(parsed);
		return {
			url, finalUrl, contentType: mime, method: "feed",
			content: output.content, fetchedAt, truncated: output.truncated, notes,
		};
	}

	if (isText && !looksLikeHtml(rawContent)) {
		const output = finalizeOutput(rawContent);
		return {
			url, finalUrl, contentType: mime, method: "text",
			content: output.content, fetchedAt, truncated: output.truncated, notes,
		};
	}

	// Step 5: For HTML, try digestible formats first (unless raw mode)
	if (isHtml && !raw) {
		// 5A: Check for page-specific markdown alternate
		const alternates = parseAlternateLinks(rawContent, finalUrl);
		const markdownAlt = alternates.find(alt => alt.endsWith(".md") || alt.includes("markdown"));
		if (markdownAlt) {
			const resolved = markdownAlt.startsWith("http") ? markdownAlt : new URL(markdownAlt, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
				notes.push(`Used markdown alternate: ${resolved}`);
				const output = finalizeOutput(altResult.content);
				return {
					url, finalUrl, contentType: "text/markdown", method: "alternate-markdown",
					content: output.content, fetchedAt, truncated: output.truncated, notes,
				};
			}
		}

		// 5B: Try URL.md suffix (llms.txt convention)
		const mdSuffix = await tryMdSuffix(finalUrl, timeout, signal);
		if (mdSuffix) {
			notes.push("Found .md suffix version");
			const output = finalizeOutput(mdSuffix);
			return {
				url, finalUrl, contentType: "text/markdown", method: "md-suffix",
				content: output.content, fetchedAt, truncated: output.truncated, notes,
			};
		}

		// 5C: Content negotiation
		const negotiated = await tryContentNegotiation(url, timeout, signal);
		if (negotiated) {
			notes.push(`Content negotiation returned ${negotiated.type}`);
			const output = finalizeOutput(negotiated.content);
			return {
				url, finalUrl, contentType: normalizeMime(negotiated.type), method: "content-negotiation",
				content: output.content, fetchedAt, truncated: output.truncated, notes,
			};
		}

		// 5D: Check for feed alternates
		const feedAlternates = alternates.filter(alt => !alt.endsWith(".md") && !alt.includes("markdown"));
		for (const altUrl of feedAlternates.slice(0, 2)) {
			const resolved = altUrl.startsWith("http") ? altUrl : new URL(altUrl, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 200) {
				notes.push(`Used feed alternate: ${resolved}`);
				const parsed = parseFeedToMarkdown(altResult.content);
				const output = finalizeOutput(parsed);
				return {
					url, finalUrl, contentType: "application/feed", method: "alternate-feed",
					content: output.content, fetchedAt, truncated: output.truncated, notes,
				};
			}
		}

		if (signal?.aborted) throw new ToolAbortError();

		// 5E: Render HTML with jina/trafilatura/lynx/fallback
		const htmlResult = await renderHtmlToText(finalUrl, rawContent, timeout, signal);
		if (!htmlResult.ok) {
			notes.push("html rendering failed");
			const output = finalizeOutput(rawContent);
			return {
				url, finalUrl, contentType: mime, method: "raw-html",
				content: output.content, fetchedAt, truncated: output.truncated, notes,
			};
		}

		// Step 6: If rendered output is low quality, try more targeted fallbacks
		if (isLowQualityOutput(htmlResult.content)) {
			const docLinks = extractDocumentLinks(rawContent, finalUrl);
			if (docLinks.length > 0) {
				const docUrl = docLinks[0];
				const binary = await fetchBinary(docUrl, timeout, signal);
				if (binary.ok) {
					const ext = getExtensionHint(docUrl, binary.contentDisposition);
					const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
					if (converted.ok && converted.content.trim().length > htmlResult.content.length) {
						notes.push(`Extracted and converted document: ${docUrl}`);
						const output = finalizeOutput(converted.content);
						return {
							url, finalUrl, contentType: "application/document", method: "extracted-document",
							content: output.content, fetchedAt, truncated: output.truncated, notes,
						};
					}
					if (!converted.ok && converted.error) {
						notes.push(`markit conversion failed: ${converted.error}`);
					}
				} else if (binary.error) {
					notes.push(`Binary fetch failed: ${binary.error}`);
				}
			}

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url, finalUrl, contentType: "text/plain", method: "llms.txt",
					content: output.content, fetchedAt, truncated: output.truncated, notes,
				};
			}

			notes.push("Page appears to require JavaScript or is mostly navigation");
		}

		const output = finalizeOutput(htmlResult.content);
		return {
			url, finalUrl, contentType: mime, method: htmlResult.method,
			content: output.content, fetchedAt, truncated: output.truncated, notes,
		};
	}

	// Fallback: return raw content
	const output = finalizeOutput(rawContent);
	return {
		url, finalUrl, contentType: mime, method: "raw",
		content: output.content, fetchedAt, truncated: output.truncated, notes,
	};
}

// =============================================================================
// Output formatting
// =============================================================================

function buildUrlReadOutput(result: FetchRenderResult, content: string): string {
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	const textBlock = result.content.find((block) => block.type === "text");
	if (!textBlock || textBlock.type !== "text") return undefined;
	return textBlock.text;
}

function countNonEmptyLines(text: string): number {
	if (!text.trim()) return 0;
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function summarizeFetchResult(result: { content: Array<{ type: string; text?: string }> }): string {
	const text = getTextContent(result);
	if (!text) return "";

	const lines = text.split("\n");
	let method = "";
	let contentType = "";
	let bodyStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("Method: ")) method = line.slice("Method: ".length).trim();
		if (line.startsWith("Content-Type: ")) contentType = line.slice("Content-Type: ".length).trim();
		if (line.trim() === "---") {
			bodyStart = i + 1;
			break;
		}
	}

	const body = lines.slice(bodyStart).join("\n");
	const bodyLineCount = countNonEmptyLines(body);
	const details: string[] = [];
	if (method) details.push(method);
	if (contentType) details.push(contentType);
	if (bodyLineCount > 0) details.push(`${bodyLineCount} lines`);
	if (details.length === 0) return "";
	return ` → ${details.join(" • ")}`;
}

function renderExpandedText(
	result: { content: Array<{ type: string; text?: string }> },
	theme: { fg: (key: string, text: string) => string },
): Text {
	const text = getTextContent(result);
	if (!text) return new Text("", 0, 0);

	const output = text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");

	if (!output.trim()) return new Text("", 0, 0);
	return new Text(`\n${output}`, 0, 0);
}

function renderCollapsedErrorOrSummary(
	result: { content: Array<{ type: string; text?: string }> },
	isError: boolean,
	theme: { fg: (key: string, text: string) => string },
	summaryText: string,
): Text {
	if (!isError) return new Text(theme.fg("muted", summaryText), 0, 0);

	const text = getTextContent(result);
	const firstLine = text?.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) return new Text(theme.fg("error", " → failed"), 0, 0);

	return new Text(theme.fg("error", ` → ${firstLine}`), 0, 0);
}

// =============================================================================
// Tool Definition
// =============================================================================

export function createFetchTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "fetch",
		label: "Fetch URL",
		description:
			"Fetch a URL and extract clean text/markdown content. " +
			"Supports HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, " +
			"RSS/Atom feeds, JSON endpoints, PDFs, images, and 76+ site-specific extractors. " +
			"Returns reader-mode text by default.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 20)" })),
			raw: Type.Optional(Type.Boolean({ description: "Return raw content without special handling" })),
		}),
		async execute(_toolCallId, params, signal) {
			const { url, timeout = 20, raw = false } = params;
			const effectiveTimeout = Math.max(5, Math.min(timeout, 120));

			// Check cache
			const cacheKey = getCacheKey(url, raw);
			const cached = cache.get(cacheKey);
			if (cached) {
				return {
					content: [{ type: "text" as const, text: cached.output }],
					details: {},
				};
			}

			const result = await renderUrl(url, effectiveTimeout, raw, signal);
			const output = buildUrlReadOutput(result, result.content);

			// Store in cache
			const entry: CacheEntry = { result, output };
			cache.set(cacheKey, entry);
			// Also cache by final URL if different
			if (result.finalUrl !== url) {
				cache.set(getCacheKey(result.finalUrl, raw), entry);
			}

			const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: output },
			];
			if (result.image) {
				contentBlocks.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
			}

			return {
				content: contentBlocks,
				details: {},
			};
		},
		renderCall(args, theme) {
			const url = String(args.url || "...");
			const compactUrl = url.length > 90 ? `${url.slice(0, 89)}…` : url;
			let text = `${theme.fg("toolTitle", theme.bold("fetch"))} ${theme.fg("accent", compactUrl)}`;
			if (args.raw) text += theme.fg("warning", " [raw]");
			if (args.timeout !== undefined) text += theme.fg("muted", ` (timeout ${args.timeout}s)`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			return renderCollapsedErrorOrSummary(result, context.isError, theme, summarizeFetchResult(result));
		},
	});
}
