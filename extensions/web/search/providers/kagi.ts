/**
 * Kagi Web Search Provider
 *
 * Inlined Kagi API implementation (no shared module dependency).
 * Uses the Kagi Search API v0.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampNumResults } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { findCredential, toSearchSources } from "./utils.js";

const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

interface KagiSearchResultObject {
	t: 0;
	url: string;
	title: string;
	snippet?: string;
	published?: string;
}

interface KagiRelatedSearchesObject {
	t: 1;
	list: string[];
}

type KagiSearchObject = KagiSearchResultObject | KagiRelatedSearchesObject;

interface KagiErrorEntry {
	code?: number;
	msg?: string;
}

interface KagiSearchResponse {
	meta: {
		id: string;
	};
	data: KagiSearchObject[];
	error?: KagiErrorEntry[];
}

function extractKagiErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;

	for (const value of [record.message, record.detail]) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	if (typeof record.error === "string" && record.error.trim().length > 0) {
		return record.error.trim();
	}

	if (Array.isArray(record.error)) {
		for (const entry of record.error) {
			if (!entry || typeof entry !== "object") continue;
			const message = (entry as Record<string, unknown>).msg;
			if (typeof message === "string" && message.trim().length > 0) {
				return message.trim();
			}
		}
	}

	return null;
}

/** Find Kagi API key from environment. */
export async function findApiKey(): Promise<string | null> {
	return findCredential(getEnvApiKey("kagi"));
}

/** Execute Kagi web search. */
export async function searchKagi(params: {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const apiKey = await findApiKey();
	if (!apiKey) {
		throw new SearchProviderError("kagi", "Kagi credentials not found. Set KAGI_API_KEY in environment.");
	}

	const requestUrl = new URL(KAGI_SEARCH_URL);
	requestUrl.searchParams.set("q", params.query);
	requestUrl.searchParams.set("limit", String(numResults));

	const response = await fetch(requestUrl, {
		headers: {
			Authorization: `Bot ${apiKey}`,
			Accept: "application/json",
		},
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let message = errorText.trim();
		if (message.length > 0) {
			try {
				message = extractKagiErrorMessage(JSON.parse(errorText)) ?? message;
			} catch {
				// keep raw text
			}
		}
		throw new SearchProviderError(
			"kagi",
			message ? `Kagi API error (${response.status}): ${message}` : `Kagi API error (${response.status})`,
			response.status,
		);
	}

	const payload = (await response.json()) as KagiSearchResponse;
	if (payload.error && payload.error.length > 0) {
		const firstError = payload.error[0];
		throw new SearchProviderError(
			"kagi",
			`Kagi API error (${firstError.code ?? response.status}): ${extractKagiErrorMessage(payload) ?? "Unknown error"}`,
			firstError.code ?? response.status,
		);
	}

	interface KagiSource {
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}

	const sources: KagiSource[] = [];
	const relatedQuestions: string[] = [];

	for (const item of payload.data) {
		if (item.t === 0) {
			sources.push({
				title: item.title,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.published ?? undefined,
			});
		} else if (item.t === 1) {
			relatedQuestions.push(...item.list);
		}
	}

	return {
		provider: "kagi",
		sources: toSearchSources(sources, numResults),
		relatedQuestions: relatedQuestions.length > 0 ? relatedQuestions : undefined,
		requestId: payload.meta.id,
	};
}

/** Search provider for Kagi web search. */
export class KagiProvider extends SearchProvider {
	readonly id = "kagi";
	readonly label = "Kagi";

	async isAvailable() {
		try {
			return !!(await findApiKey());
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchKagi({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
