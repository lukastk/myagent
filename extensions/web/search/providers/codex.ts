/**
 * OpenAI Codex Web Search Provider
 *
 * Uses OpenAI's Responses API with web_search tool.
 * Simplified: only supports OPENAI_API_KEY (no OAuth/agent.db).
 * Returns synthesized answers with web search sources.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { isApiKeyAvailable } from "./utils.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

export interface CodexSearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** Codex API response structure */
interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexApiResponse {
	id?: string;
	model?: string;
	status?: string;
	output?: CodexResponseItem[];
	usage?: CodexUsage;
	error?: { message?: string };
}

/** Find OPENAI_API_KEY from environment. */
export function findApiKey(): string | null {
	return getEnvApiKey("openai") ?? null;
}

function getModel(): string {
	return process.env.OPENAI_SEARCH_MODEL?.trim() ?? DEFAULT_MODEL;
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

/**
 * Calls the OpenAI Responses API with web search tool enabled (non-streaming).
 */
async function callCodexSearch(
	apiKey: string,
	query: string,
	options: { signal?: AbortSignal; systemPrompt?: string; searchContextSize?: "low" | "medium" | "high" },
): Promise<{
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const requestedModel = getModel();

	const body: Record<string, unknown> = {
		model: requestedModel,
		input: query,
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const response = await fetch(OPENAI_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError("codex", `OpenAI API error (${response.status}): ${errorText}`, response.status);
	}

	const data = (await response.json()) as CodexApiResponse;

	if (data.error) {
		throw new SearchProviderError("codex", `OpenAI error: ${data.error.message ?? "Unknown error"}`, 500);
	}

	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = data.model ?? requestedModel;
	const requestId = data.id ?? "";

	for (const item of data.output ?? []) {
		// Handle text message content and extract sources from annotations
		if (item.type === "message" && item.content) {
			for (const part of item.content) {
				if (part.type === "output_text" && part.text) {
					answerParts.push(part.text);

					// Extract sources from url_citation annotations
					if (part.annotations) {
						for (const annotation of part.annotations) {
							if (annotation.type === "url_citation" && annotation.url) {
								addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
							}
						}
					}
				}
			}
		}

		// Handle reasoning summary as part of answer
		if (item.type === "reasoning" && item.summary) {
			for (const part of item.summary) {
				if (part.type === "summary_text" && part.text) {
					answerParts.push(part.text);
				}
			}
		}
	}

	const answer = answerParts.join("\n\n").trim();

	// Fallback: when response omits url_citation annotations, scrape markdown links
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(sources, source);
		}
	}

	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
	if (data.usage) {
		const cachedTokens = data.usage.input_tokens_details?.cached_tokens ?? 0;
		usage = {
			inputTokens: (data.usage.input_tokens ?? 0) - cachedTokens,
			outputTokens: data.usage.output_tokens ?? 0,
			totalTokens: data.usage.total_tokens ?? 0,
		};
	}

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
}

/**
 * Executes a web search using OpenAI's Responses API with web search tool.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function searchCodex(params: CodexSearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("No OpenAI credentials found. Set OPENAI_API_KEY in environment.");
	}

	const result = await callCodexSearch(apiKey, params.query, {
		signal: params.signal,
		systemPrompt: params.system_prompt,
		searchContextSize: params.search_context_size ?? "high",
	});

	let sources = result.sources;

	// Apply num_results limit if specified
	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/** Search provider for OpenAI web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "Codex";

	isAvailable(): Promise<boolean> {
		return isApiKeyAvailable(findApiKey);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex({
			signal: params.signal,
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
		});
	}
}
