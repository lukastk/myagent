/**
 * Unified Web Search Tool — multi-provider with automatic fallback.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { ensureSearchProviderCredentials } from "../lib/env-keys.js";
import { SEARCH_SYSTEM_PROMPT, SEARCH_TOOL_DESCRIPTION } from "../prompts/search.js";
import { getSearchProvider, resolveProviderChain, type SearchProvider } from "./provider.js";
import type { SearchProviderId, SearchResponse } from "./types.js";
import { SearchProviderError } from "./types.js";

export { setPreferredSearchProvider } from "./provider.js";
export { isSearchProviderPreference } from "./types.js";
export type { SearchProviderId, SearchResponse } from "./types.js";

/** Web search tool parameters schema */
const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	recency: Type.Optional(
		StringEnum(["day", "week", "month", "year"], {
			description: "Recency filter for search results",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max results to return" })),
	max_tokens: Type.Optional(Type.Number({ description: "Maximum output tokens" })),
	temperature: Type.Optional(Type.Number({ description: "Sampling temperature" })),
	num_search_results: Type.Optional(Type.Number({ description: "Number of search results to retrieve" })),
});

type SearchToolParams = {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	max_tokens?: number;
	temperature?: number;
	num_search_results?: number;
};

interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

function formatProviderList(providers: SearchProvider[]): string {
	return providers.map(provider => provider.label).join(", ");
}

function formatProviderError(error: unknown, provider: SearchProvider): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProvider(error.provider).label} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format age in seconds to human-readable string. */
function formatAge(ageSeconds: number | undefined): string | undefined {
	if (ageSeconds === undefined || ageSeconds < 0) return undefined;
	if (ageSeconds < 60) return `${ageSeconds}s ago`;
	if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
	if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
	if (ageSeconds < 604800) return `${Math.floor(ageSeconds / 86400)}d ago`;
	if (ageSeconds < 2592000) return `${Math.floor(ageSeconds / 604800)}w ago`;
	if (ageSeconds < 31536000) return `${Math.floor(ageSeconds / 2592000)}mo ago`;
	return `${Math.floor(ageSeconds / 31536000)}y ago`;
}

/** Truncate text for tool output */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** Format response for LLM consumption */
function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncateText(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncateText(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncateText(query, 120)}`);
		}
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	return Boolean(
		response.answer?.trim() ||
			response.sources.length > 0 ||
			response.citations?.length ||
			response.relatedQuestions?.some(question => question.trim()) ||
			response.searchQueries?.some(query => query.trim()),
	);
}

/** Execute web search with provider fallback. */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	await ensureSearchProviderCredentials();
	const providers =
		params.provider && params.provider !== "auto"
			? (await getSearchProvider(params.provider).isAvailable())
				? [getSearchProvider(params.provider)]
				: await resolveProviderChain("auto")
			: await resolveProviderChain();
	if (providers.length === 0) {
		throw new Error(
			"No web search provider is configured in the environment or the mysetup secret vault.",
		);
	}

	let lastError: unknown;
	let lastProvider = providers[0];

	for (const provider of providers) {
		lastProvider = provider;
		try {
			const response = await provider.search({
				query: params.query.replace(/202\d/g, String(new Date().getFullYear())),
				limit: params.limit,
				recency: params.recency,
				systemPrompt: SEARCH_SYSTEM_PROMPT,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
			});

			if (!hasRenderableSearchContent(response)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no search results.`, 204);
			}
			const text = formatForLLM(response);

			return {
				content: [{ type: "text" as const, text }],
				details: { response },
			};
		} catch (error) {
			signal?.throwIfAborted();
			lastError = error;
		}
	}

	const baseMessage = formatProviderError(lastError, lastProvider);
	const message =
		providers.length > 1
			? `All web search providers failed (${formatProviderList(providers)}). Last error: ${baseMessage}`
			: baseMessage;

	throw new Error(message);
}

/** Create the web search tool definition for Pi. */
export function createWebSearchTool() {
	return defineTool({
		name: "web_search",
		label: "Web Search",
		description: SEARCH_TOOL_DESCRIPTION,
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal) {
			return executeSearch(_toolCallId, params as SearchToolParams, signal);
		},
	});
}
