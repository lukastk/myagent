/**
 * Google Gemini Web Search Provider
 *
 * Uses Gemini's Google Search grounding via the Google AI API (generativelanguage.googleapis.com).
 * Requires GEMINI_API_KEY environment variable.
 * Returns synthesized answers with citations and source metadata from grounding chunks.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import { sleep } from "../../lib/utils.js";
import type { SearchCitation, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { isApiKeyAvailable } from "./utils.js";

const GOOGLE_AI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. */
	max_output_tokens?: number;
	/** Sampling temperature (0-1). Lower = more focused/factual. */
	temperature?: number;
	signal?: AbortSignal;
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) {
		tools.push({ codeExecution: params.code_execution });
	}
	if (params.url_context !== undefined) {
		tools.push({ urlContext: params.url_context });
	}
	return tools;
}

/** Find GEMINI_API_KEY from environment. */
export function findApiKey(): string | null {
	return getEnvApiKey("gemini") ?? null;
}

/** Grounding metadata types from Google AI API */
interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

interface GeminiCandidate {
	content?: {
		role: string;
		parts?: Array<{ text?: string }>;
	};
	finishReason?: string;
	groundingMetadata?: GeminiGroundingMetadata;
}

interface GeminiApiResponse {
	candidates?: GeminiCandidate[];
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
	modelVersion?: string;
}

/**
 * Calls the Google AI generateContent API with Google Search grounding.
 */
async function callGeminiSearch(
	apiKey: string,
	query: string,
	systemPrompt?: string,
	maxOutputTokens?: number,
	temperature?: number,
	toolParams: GeminiToolParams = {},
	signal?: AbortSignal,
): Promise<{
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const model = process.env.GEMINI_SEARCH_MODEL ?? DEFAULT_MODEL;
	const url = `${GOOGLE_AI_BASE_URL}/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const requestBody: Record<string, unknown> = {
		contents: [
			{
				role: "user",
				parts: [{ text: query }],
			},
		],
		tools: buildGeminiRequestTools(toolParams),
	};

	if (systemPrompt) {
		requestBody.systemInstruction = {
			parts: [{ text: systemPrompt }],
		};
	}

	if (maxOutputTokens !== undefined || temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (maxOutputTokens !== undefined) {
			generationConfig.maxOutputTokens = maxOutputTokens;
		}
		if (temperature !== undefined) {
			generationConfig.temperature = temperature;
		}
		requestBody.generationConfig = generationConfig;
	}

	let response: Response | undefined;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
				signal,
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (attempt < MAX_RETRIES) {
				await sleep(BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}

		if (response.ok) {
			break;
		}

		const errorText = await response.text();
		const isRetryableStatus =
			response.status === 429 ||
			response.status === 500 ||
			response.status === 502 ||
			response.status === 503 ||
			response.status === 504;

		if (isRetryableStatus && attempt < MAX_RETRIES) {
			await sleep(BASE_DELAY_MS * 2 ** attempt);
			continue;
		}

		throw new SearchProviderError(
			"gemini",
			`Gemini API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response) {
		throw new SearchProviderError("gemini", "Gemini API request failed", 500);
	}

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"gemini",
			`Gemini API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const data = (await response.json()) as GeminiApiResponse;

	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	let resultModel = model;
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	const candidate = data.candidates?.[0];

	// Extract text content
	if (candidate?.content?.parts) {
		for (const part of candidate.content.parts) {
			if (part.text) {
				answerParts.push(part.text);
			}
		}
	}

	// Extract grounding metadata
	const groundingMetadata = candidate?.groundingMetadata;
	if (groundingMetadata) {
		// Extract sources from grounding chunks
		if (groundingMetadata.groundingChunks) {
			for (const grChunk of groundingMetadata.groundingChunks) {
				if (grChunk.web?.uri) {
					const sourceUrl = grChunk.web.uri;
					if (!seenUrls.has(sourceUrl)) {
						seenUrls.add(sourceUrl);
						sources.push({
							title: grChunk.web.title ?? sourceUrl,
							url: sourceUrl,
						});
					}
				}
			}
		}

		// Extract citations from grounding supports
		if (groundingMetadata.groundingSupports && groundingMetadata.groundingChunks) {
			for (const support of groundingMetadata.groundingSupports) {
				const citedText = support.segment?.text;
				const chunkIndices = support.groundingChunkIndices ?? [];

				for (const idx of chunkIndices) {
					const grChunk = groundingMetadata.groundingChunks[idx];
					if (grChunk?.web?.uri) {
						citations.push({
							url: grChunk.web.uri,
							title: grChunk.web.title ?? grChunk.web.uri,
							citedText,
						});
					}
				}
			}
		}

		// Extract search queries
		if (groundingMetadata.webSearchQueries) {
			for (const q of groundingMetadata.webSearchQueries) {
				if (!searchQueries.includes(q)) {
					searchQueries.push(q);
				}
			}
		}
	}

	// Extract usage metadata
	if (data.usageMetadata) {
		usage = {
			inputTokens: data.usageMetadata.promptTokenCount ?? 0,
			outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
			totalTokens: data.usageMetadata.totalTokenCount ?? 0,
		};
	}

	// Extract model version
	if (data.modelVersion) {
		resultModel = data.modelVersion;
	}

	return {
		answer: answerParts.join(""),
		sources,
		citations,
		searchQueries,
		model: resultModel,
		usage,
	};
}

/**
 * Executes a web search using Google Gemini with Google Search grounding.
 * Requires GEMINI_API_KEY environment variable.
 */
export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("No Gemini credentials found. Set GEMINI_API_KEY in environment.");
	}

	const result = await callGeminiSearch(
		apiKey,
		params.query,
		params.system_prompt,
		params.max_output_tokens,
		params.temperature,
		{
			google_search: params.google_search,
			code_execution: params.code_execution,
			url_context: params.url_context,
		},
		params.signal,
	);

	let sources = result.sources;

	// Apply num_results limit if specified
	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

/** Search provider for Google Gemini web search. */
export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable() {
		return isApiKeyAvailable(findApiKey);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
		});
	}
}
