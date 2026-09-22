/**
 * Kagi Web Search Provider
 *
 * Uses Kagi's current Search API v1 and returns its premium structured results.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampNumResults } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { findCredential, toSearchSources } from "./utils.js";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

interface KagiSearchResult {
	url: string;
	title: string;
	snippet?: string;
	time?: string;
	props?: { question?: string };
}

interface KagiErrorEntry {
	code?: string;
	message?: string | null;
}

interface KagiSearchResponse {
	meta?: { trace?: string };
	data?: {
		search?: KagiSearchResult[];
		related_search?: KagiSearchResult[];
	};
	error?: KagiErrorEntry[];
}

function extractKagiErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;
	for (const value of [record.message, record.detail]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (Array.isArray(record.error)) {
		const messages = record.error
			.map(entry => {
				if (!entry || typeof entry !== "object") return undefined;
				const error = entry as Record<string, unknown>;
				const message = typeof error.message === "string" ? error.message.trim() : "";
				const code = typeof error.code === "string" ? error.code.trim() : "";
				return message || code || undefined;
			})
			.filter((message): message is string => Boolean(message));
		if (messages.length > 0) return messages.join("; ");
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
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const apiKey = await findApiKey();
	if (!apiKey) {
		throw new SearchProviderError("kagi", "Kagi credentials not found. Set KAGI_API_KEY in environment.");
	}

	const body: Record<string, unknown> = {
		query: params.query,
		workflow: "search",
		format: "json",
		limit: numResults,
	};
	if (params.recency && params.recency !== "year") {
		body.lens = { time_relative: params.recency };
	} else if (params.recency === "year") {
		const after = new Date();
		after.setUTCFullYear(after.getUTCFullYear() - 1);
		body.filters = { after: after.toISOString().slice(0, 10) };
	}

	const response = await fetch(KAGI_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: params.signal,
	});

	const rawText = await response.text();
	let payload: KagiSearchResponse | undefined;
	if (rawText) {
		try {
			payload = JSON.parse(rawText) as KagiSearchResponse;
		} catch {
			// Keep the raw response as the error message below.
		}
	}
	if (!response.ok || payload?.error?.length) {
		const message = extractKagiErrorMessage(payload) ?? (rawText.trim() || "Unknown error");
		throw new SearchProviderError("kagi", `Kagi API error (${response.status}): ${message}`, response.status);
	}
	if (!payload) {
		throw new SearchProviderError("kagi", "Kagi search returned an empty response.", response.status);
	}

	const sources = (payload.data?.search ?? [])
		.filter(result => Boolean(result.url))
		.map(result => ({
			title: result.title || result.url,
			url: result.url,
			snippet: result.snippet,
			publishedDate: result.time,
		}));
	const relatedQuestions = (payload.data?.related_search ?? [])
		.map(result => result.props?.question?.trim())
		.filter((question): question is string => Boolean(question));

	return {
		provider: "kagi",
		sources: toSearchSources(sources, numResults),
		relatedQuestions: relatedQuestions.length > 0 ? relatedQuestions : undefined,
		requestId: payload.meta?.trace,
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
			recency: params.recency,
			signal: params.signal,
		});
	}
}
