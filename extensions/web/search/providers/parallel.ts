/**
 * Parallel Web Search Provider
 *
 * Inlined Parallel API implementation (no shared module dependency).
 * Uses the Parallel Search API v1beta.
 */
import { getEnvApiKey } from "../../lib/env-keys.js";
import type { SearchResponse } from "../types.js";
import { SearchProviderError } from "../types.js";
import { clampNumResults } from "../utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";
import { findCredential, toSearchSources } from "./utils.js";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 40;

interface ParallelSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

/** Find Parallel API key from environment. */
export async function findApiKey(): Promise<string | null> {
	return findCredential(getEnvApiKey("parallel"));
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function getString(value: object, key: string): string | undefined {
	const candidate = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof candidate === "string" ? candidate : undefined;
}

function getStringArray(value: object, key: string): string[] {
	const candidate = Object.getOwnPropertyDescriptor(value, key)?.value;
	if (!Array.isArray(candidate)) return [];
	return candidate.filter(item => typeof item === "string");
}

function getObjectArray(value: object, key: string): object[] {
	const candidate = Object.getOwnPropertyDescriptor(value, key)?.value;
	if (!Array.isArray(candidate)) return [];
	return candidate.filter(isObject);
}

function extractErrorMessage(payload: unknown): string | null {
	if (!isObject(payload)) return null;

	const directMessage = getString(payload, "message") ?? getString(payload, "detail") ?? getString(payload, "error");
	if (directMessage && directMessage.trim().length > 0) {
		return directMessage.trim();
	}

	const errorObject = Object.getOwnPropertyDescriptor(payload, "error")?.value;
	if (isObject(errorObject)) {
		const nestedMessage = getString(errorObject, "message") ?? getString(errorObject, "detail");
		if (nestedMessage && nestedMessage.trim().length > 0) {
			return nestedMessage.trim();
		}
	}

	return null;
}

/** Execute Parallel web search. */
export async function searchParallel(params: {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const apiKey = await findApiKey();
	if (!apiKey) {
		throw new SearchProviderError("parallel", "Parallel credentials not found. Set PARALLEL_API_KEY in environment.");
	}

	const response = await fetch(PARALLEL_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"parallel-beta": PARALLEL_BETA_HEADER,
		},
		body: JSON.stringify({
			objective: params.query,
			search_queries: [params.query],
			mode: "fast",
			excerpts: {
				max_chars_per_result: 10_000,
			},
		}),
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let message = errorText.trim();
		if (message.length > 0) {
			try {
				message = extractErrorMessage(JSON.parse(errorText)) ?? message;
			} catch {
				// keep raw text
			}
		}
		throw new SearchProviderError(
			"parallel",
			message ? `Parallel API error (${response.status}): ${message}` : `Parallel API error (${response.status})`,
			response.status,
		);
	}

	const payload: unknown = await response.json();
	if (!isObject(payload)) {
		throw new SearchProviderError("parallel", "Parallel search returned an invalid response payload.", 500);
	}

	const requestId = getString(payload, "search_id") ?? "";
	const rawResults = getObjectArray(payload, "results");
	const sources: ParallelSource[] = [];

	for (const item of rawResults) {
		const url = getString(item, "url");
		if (!url) continue;

		const excerpts = getStringArray(item, "excerpts");
		const snippet = excerpts.length > 0 ? excerpts.join("\n\n") : undefined;
		sources.push({
			title: getString(item, "title") ?? url,
			url,
			snippet,
			publishedDate: getString(item, "publish_date"),
		});
	}

	return {
		provider: "parallel",
		sources: toSearchSources(sources, numResults),
		requestId,
	};
}

/** Search provider for Parallel. */
export class ParallelProvider extends SearchProvider {
	readonly id = "parallel";
	readonly label = "Parallel";

	async isAvailable() {
		try {
			return !!(await findApiKey());
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchParallel({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
