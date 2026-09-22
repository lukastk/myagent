/**
 * TinyFish Web Search Provider
 *
 * Uses TinyFish's free Search API for structured titles, URLs, and snippets.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampNumResults, dateToAgeSeconds } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { isApiKeyAvailable } from "./utils.js";

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 10;

const RECENCY_MINUTES: Record<"day" | "week" | "month" | "year", number> = {
	day: 1_440,
	week: 10_080,
	month: 43_800,
	year: 525_600,
};

interface TinyFishSearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	date?: string | null;
}

interface TinyFishSearchResponse {
	results?: TinyFishSearchResult[];
}

/** Find TINYFISH_API_KEY from the environment or mysetup secret vault. */
export function findApiKey(): string | null {
	return getEnvApiKey("tinyfish") ?? null;
}

/** Execute a TinyFish structured web search. */
export async function searchTinyFish(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new SearchProviderError(
			"tinyfish",
			"TinyFish credentials not found. Set TINYFISH_API_KEY in environment.",
		);
	}

	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const url = new URL(TINYFISH_SEARCH_URL);
	url.searchParams.set("query", params.query);
	if (params.recency) url.searchParams.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));

	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-API-Key": apiKey,
		},
		signal: params.signal,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"tinyfish",
			`TinyFish API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	const payload = (await response.json()) as TinyFishSearchResponse;
	const sources: SearchSource[] = [];
	for (const result of payload.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title?.trim() || result.url,
			url: result.url,
			snippet: result.snippet?.trim() || undefined,
			publishedDate: result.date ?? undefined,
			ageSeconds: dateToAgeSeconds(result.date),
		});
	}

	return {
		provider: "tinyfish",
		sources: sources.slice(0, numResults),
	};
}

/** Search provider for TinyFish Search. */
export class TinyFishProvider extends SearchProvider {
	readonly id = "tinyfish";
	readonly label = "TinyFish";

	isAvailable() {
		return isApiKeyAvailable(findApiKey);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTinyFish({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
