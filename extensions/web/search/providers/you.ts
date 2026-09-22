/**
 * You.com Web Search Provider
 *
 * Uses You.com's Web Search API, which returns structured web/news results
 * without calling its separate Answer or Research synthesis APIs.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampNumResults, dateToAgeSeconds } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { isApiKeyAvailable } from "./utils.js";

const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

interface YouSearchResult {
	url?: string | null;
	title?: string | null;
	description?: string | null;
	snippets?: string[] | null;
	page_age?: string | null;
}

interface YouSearchResponse {
	results?: {
		web?: YouSearchResult[];
		news?: YouSearchResult[];
	};
	metadata?: {
		search_uuid?: string;
	};
}

/** Find YDC_API_KEY from the environment or mysetup secret vault. */
export function findApiKey(): string | null {
	return getEnvApiKey("you") ?? null;
}

function buildSnippet(result: YouSearchResult): string | undefined {
	const parts: string[] = [];
	for (const text of [result.description, ...(result.snippets ?? [])]) {
		const trimmed = text?.trim();
		if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Execute a You.com structured web search. */
export async function searchYou(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new SearchProviderError("you", "You.com credentials not found. Set YDC_API_KEY in environment.");
	}

	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const response = await fetch(YOU_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-API-Key": apiKey,
		},
		body: JSON.stringify({
			query: params.query,
			count: numResults,
			...(params.recency ? { freshness: params.recency } : {}),
		}),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"you",
			`You.com API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const payload = (await response.json()) as YouSearchResponse;
	const sources: SearchSource[] = [];
	for (const result of [...(payload.results?.web ?? []), ...(payload.results?.news ?? [])]) {
		if (!result.url) continue;
		sources.push({
			title: result.title?.trim() || result.url,
			url: result.url,
			snippet: buildSnippet(result),
			publishedDate: result.page_age ?? undefined,
			ageSeconds: dateToAgeSeconds(result.page_age),
		});
	}

	return {
		provider: "you",
		sources: sources.slice(0, numResults),
		requestId: payload.metadata?.search_uuid,
	};
}

/** Search provider for You.com Web Search. */
export class YouProvider extends SearchProvider {
	readonly id = "you";
	readonly label = "You.com";

	isAvailable() {
		return isApiKeyAvailable(findApiKey);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchYou({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
