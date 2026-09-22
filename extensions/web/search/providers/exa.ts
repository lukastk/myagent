/**
 * Exa Web Search Provider
 *
 * High-quality neural search via Exa Search API.
 * Returns structured search results with query-relevant source highlights,
 * not per-result AI summaries or a synthesized answer.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { dateToAgeSeconds } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { isApiKeyAvailable } from "./utils.js";

const EXA_API_URL = "https://api.exa.ai/search";

type ExaSearchType = "neural" | "fast" | "auto" | "deep";

type ExaSearchParamType = ExaSearchType | "keyword";

export interface ExaSearchParams {
	query: string;
	num_results?: number;
	type?: ExaSearchParamType;
	include_domains?: string[];
	exclude_domains?: string[];
	start_published_date?: string;
	end_published_date?: string;
	signal?: AbortSignal;
}

interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	author?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	highlights?: string[] | null;
}

interface ExaSearchResponse {
	requestId?: string;
	resolvedSearchType?: string;
	results?: ExaSearchResult[];
	costDollars?: { total: number };
	searchTime?: number;
}

/** Find EXA_API_KEY from environment. */
export function findApiKey(): string | null {
	return getEnvApiKey("exa") ?? null;
}

export function normalizeSearchType(type: ExaSearchParamType | undefined): ExaSearchType {
	if (!type) return "auto";
	if (type === "keyword") return "fast";
	return type;
}

/** Build the request body for `callExaSearch`. Exported for testing. */
export function buildExaRequestBody(params: ExaSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: params.num_results ?? 10,
		type: normalizeSearchType(params.type),
		contents: {
			highlights: { query: params.query },
		},
	};

	if (params.include_domains?.length) {
		body.includeDomains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		body.excludeDomains = params.exclude_domains;
	}
	if (params.start_published_date) {
		body.startPublishedDate = params.start_published_date;
	}
	if (params.end_published_date) {
		body.endPublishedDate = params.end_published_date;
	}

	return body;
}

/** Call Exa Search API */
async function callExaSearch(apiKey: string, params: ExaSearchParams): Promise<ExaSearchResponse> {
	const body = buildExaRequestBody(params);

	const response = await fetch(EXA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError("exa", `Exa API error (${response.status}): ${errorText}`, response.status);
	}

	return response.json() as Promise<ExaSearchResponse>;
}

/** Execute Exa web search */
export async function searchExa(params: ExaSearchParams): Promise<SearchResponse> {
	const apiKey = findApiKey();
	if (!apiKey) {
		throw new Error("EXA_API_KEY not found. Set it in environment or .env file.");
	}

	const response = await callExaSearch(apiKey, params);

	// Convert to unified SearchResponse
	const sources: SearchSource[] = [];

	if (response.results) {
		for (const result of response.results) {
			if (!result.url) continue;
			sources.push({
				title: result.title ?? result.url,
				url: result.url,
				snippet: result.highlights?.join("\n") || result.text || undefined,
				publishedDate: result.publishedDate ?? undefined,
				ageSeconds: dateToAgeSeconds(result.publishedDate ?? undefined),
				author: result.author ?? undefined,
			});
		}
	}

	// Apply num_results limit if specified
	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	return {
		provider: "exa",
		sources: limitedSources,
		requestId: response.requestId,
	};
}

/** Search provider for Exa. */
export class ExaProvider extends SearchProvider {
	readonly id = "exa";
	readonly label = "Exa";

	isAvailable() {
		return isApiKeyAvailable(findApiKey);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchExa({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
