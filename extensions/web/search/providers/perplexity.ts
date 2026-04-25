/**
 * Perplexity Web Search Provider
 *
 * Supports API key (`PERPLEXITY_API_KEY`) via `api.perplexity.ai/chat/completions`.
 * OAuth/cookie modes stripped for simplicity.
 */

import { getEnvApiKey } from "../../lib/env-keys.js";
import type {
	PerplexityMessageOutput,
	PerplexityRequest,
	PerplexityResponse,
	SearchCitation,
	SearchResponse,
	SearchSource,
} from "../types.js";
import { SearchProviderError } from "../types.js";
import { dateToAgeSeconds } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_SEARCH_RESULTS = 10;

export interface PerplexitySearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
	num_results?: number;
	/** Maximum output tokens. Defaults to 8192. */
	max_tokens?: number;
	/** Sampling temperature (0-1). Lower = more focused/factual. Defaults to 0.2. */
	temperature?: number;
	/** Number of search results to retrieve. Defaults to 10. */
	num_search_results?: number;
}

/** Find PERPLEXITY_API_KEY from environment. */
export function findApiKey(): string | null {
	return getEnvApiKey("perplexity") ?? null;
}

/** Call Perplexity API-key endpoint. */
async function callPerplexityApi(
	apiKey: string,
	request: PerplexityRequest,
	signal?: AbortSignal,
): Promise<PerplexityResponse> {
	const response = await fetch(PERPLEXITY_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"perplexity",
			`Perplexity API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return response.json() as Promise<PerplexityResponse>;
}

function messageContentToText(content: PerplexityMessageOutput["content"]): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content.map(chunk => (chunk.type === "text" ? chunk.text : "")).join("");
}

/** Parse API response into unified SearchResponse */
function parseResponse(response: PerplexityResponse): SearchResponse {
	const messageContent = response.choices[0]?.message?.content ?? null;
	const answer = messageContentToText(messageContent);

	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	const citationUrls = response.citations ?? [];
	const searchResults = response.search_results ?? [];

	if (citationUrls.length > 0) {
		for (const url of citationUrls) {
			const searchResult = searchResults.find(r => r.url === url);
			sources.push({
				title: searchResult?.title ?? url,
				url,
				snippet: searchResult?.snippet,
				publishedDate: searchResult?.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult?.date),
			});
			citations.push({
				url,
				title: searchResult?.title ?? url,
			});
		}
	} else {
		for (const searchResult of searchResults) {
			sources.push({
				title: searchResult.title ?? searchResult.url,
				url: searchResult.url,
				snippet: searchResult.snippet,
				publishedDate: searchResult.date ?? undefined,
				ageSeconds: dateToAgeSeconds(searchResult.date),
			});
		}
	}

	return {
		provider: "perplexity",
		answer: answer || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		usage: response.usage
			? {
					inputTokens: response.usage.prompt_tokens,
					outputTokens: response.usage.completion_tokens,
					totalTokens: response.usage.total_tokens,
				}
			: undefined,
		model: response.model,
		requestId: response.id,
	};
}

function applySourceLimit(result: SearchResponse, limit?: number): SearchResponse {
	if (limit && result.sources.length > limit) {
		result.sources = result.sources.slice(0, limit);
	}
	return result;
}

/** Execute Perplexity web search */
export async function searchPerplexity(params: PerplexitySearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("Perplexity auth not found. Set PERPLEXITY_API_KEY in environment.");
	}

	const systemPrompt = params.system_prompt;
	const messages: PerplexityRequest["messages"] = [];
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}
	messages.push({ role: "user", content: params.query });

	const request: PerplexityRequest = {
		model: "sonar-pro",
		messages,
		max_tokens: params.max_tokens ?? DEFAULT_MAX_TOKENS,
		temperature: params.temperature ?? DEFAULT_TEMPERATURE,
		search_mode: "web",
		num_search_results: params.num_search_results ?? DEFAULT_NUM_SEARCH_RESULTS,
		web_search_options: {
			search_type: "pro",
			search_context_size: "medium",
		},
		enable_search_classifier: true,
		reasoning_effort: "medium",
		language_preference: "en",
	};

	if (params.search_recency_filter) {
		request.search_recency_filter = params.search_recency_filter;
	}

	const response = await callPerplexityApi(apiKey, request, params.signal);
	const result = parseResponse(response);
	result.authMode = "api_key";
	return applySourceLimit(result, params.num_results);
}

/** Search provider for Perplexity. */
export class PerplexityProvider extends SearchProvider {
	readonly id = "perplexity";
	readonly label = "Perplexity";

	async isAvailable() {
		try {
			return !!findApiKey();
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPerplexity({
			signal: params.signal,
			query: params.query,
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
			num_search_results: params.numSearchResults,
			system_prompt: params.systemPrompt,
			search_recency_filter: params.recency,
			num_results: params.limit,
		});
	}
}
