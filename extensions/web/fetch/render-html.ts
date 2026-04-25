/**
 * HTML-to-text rendering chain.
 * Tries (in order): Jina reader API, trafilatura, lynx, htmlToBasicMarkdown fallback.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { combineSignals } from "../lib/signals.js";
import { $which } from "../lib/utils.js";
import { htmlToBasicMarkdown } from "../lib/html-to-markdown.js";

const execFileAsync = promisify(execFile);

/**
 * Check if content looks JS-gated or mostly navigation
 */
export function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();

	// JS-gated indicators
	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
		return true;
	}

	// Mostly navigation (high link/menu density)
	const lines = content.split("\n").filter(l => l.trim());
	const shortLines = lines.filter(l => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
		return true;
	}

	return false;
}

/**
 * Render HTML to markdown/text using best available method.
 * Tries: Jina reader API -> trafilatura -> lynx -> htmlToBasicMarkdown fallback.
 */
export async function renderHtmlToText(
	url: string,
	html: string,
	timeout: number,
	userSignal?: AbortSignal,
): Promise<{ content: string; ok: boolean; method: string }> {
	const signal = combineSignals(userSignal, timeout * 1000);

	// Try jina first (reader API)
	try {
		const jinaUrl = `https://r.jina.ai/${url}`;
		const response = await fetch(jinaUrl, {
			headers: { Accept: "text/markdown" },
			signal,
		});
		if (response.ok) {
			const content = await response.text();
			if (content.trim().length > 100 && !isLowQualityOutput(content)) {
				return { content, ok: true, method: "jina" };
			}
		}
	} catch {
		// Jina failed, continue to next method
		if (signal?.aborted) return { content: "", ok: false, method: "none" };
	}

	// Try trafilatura (if available in PATH)
	const trafilatura = $which("trafilatura");
	if (trafilatura) {
		try {
			const result = await execFileAsync(trafilatura, ["-u", url, "--output-format", "markdown"], {
				timeout: timeout * 1000,
				maxBuffer: 10 * 1024 * 1024,
				signal,
			});
			if (result.stdout.trim().length > 100) {
				return { content: result.stdout, ok: true, method: "trafilatura" };
			}
		} catch {
			if (signal?.aborted) return { content: "", ok: false, method: "none" };
		}
	}

	// Try lynx (if available)
	const lynx = $which("lynx");
	if (lynx) {
		try {
			const result = await execFileAsync(lynx, ["-dump", "-nolist", "-width", "250", url], {
				timeout: timeout * 1000,
				maxBuffer: 10 * 1024 * 1024,
				signal,
			});
			if (result.stdout.trim().length > 100) {
				return { content: result.stdout, ok: true, method: "lynx" };
			}
		} catch {
			if (signal?.aborted) return { content: "", ok: false, method: "none" };
		}
	}

	// Fall back to htmlToBasicMarkdown (fastest, no network/subprocess)
	try {
		const content = htmlToBasicMarkdown(html);
		if (content.trim().length > 100 && !isLowQualityOutput(content)) {
			return { content, ok: true, method: "html-to-markdown" };
		}
	} catch {
		if (signal?.aborted) return { content: "", ok: false, method: "none" };
	}

	return { content: "", ok: false, method: "none" };
}
