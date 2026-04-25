/**
 * Web Search Types
 *
 * Unified types for web search responses across supported providers.
 */

/** Supported web search providers */
export type SearchProviderId =
	| "exa"
	| "brave"
	| "jina"
	| "kimi"
	| "zai"
	| "anthropic"
	| "perplexity"
	| "gemini"
	| "codex"
	| "tavily"
	| "parallel"
	| "kagi"
	| "synthetic";

export function isSearchProviderId(value: string): value is SearchProviderId {
	return [
		"exa",
		"brave",
		"jina",
		"kimi",
		"zai",
		"anthropic",
		"perplexity",
		"gemini",
		"codex",
		"tavily",
		"parallel",
		"kagi",
		"synthetic",
	].includes(value);
}

export function isSearchProviderPreference(value: string): value is SearchProviderId | "auto" {
	return value === "auto" || isSearchProviderId(value);
}

/** Source returned by search (all providers) */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

/** Citation with text reference (anthropic, perplexity) */
export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

/** Usage metrics */
export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Anthropic: number of web search requests made */
	searchRequests?: number;
	/** Perplexity: combined token count */
	totalTokens?: number;
}

/** Unified response across providers */
export interface SearchResponse {
	provider: SearchProviderId | "none";
	/** Synthesized answer text (anthropic, perplexity) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries (anthropic) */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api-key) */
	authMode?: string;
}

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	constructor(
		public readonly provider: SearchProviderId,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "SearchProviderError";
	}
}

/** Anthropic API response types */
export interface AnthropicSearchResult {
	type: "web_search_result";
	title: string;
	url: string;
	encrypted_content: string;
	page_age: string | null;
}

export interface AnthropicCitation {
	type: "web_search_result_location";
	url: string;
	title: string;
	cited_text: string;
	encrypted_index: string;
}

export interface AnthropicContentBlock {
	type: string;
	/** Text content (for type="text") */
	text?: string;
	/** Citations in text block */
	citations?: AnthropicCitation[];
	/** Tool name (for type="server_tool_use") */
	name?: string;
	/** Tool input (for type="server_tool_use") */
	input?: { query: string };
	/** Search results (for type="web_search_tool_result") */
	content?: AnthropicSearchResult[];
}

export interface AnthropicApiResponse {
	id: string;
	model: string;
	content: AnthropicContentBlock[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		server_tool_use?: { web_search_requests: number };
	};
}

/** Perplexity API types */
export type PerplexityChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface PerplexityContentTextChunk {
	type: "text";
	text: string;
}

export type PerplexityContentChunk = PerplexityContentTextChunk;

export interface PerplexitySearchResult {
	title: string;
	url: string;
	date?: string | null;
	last_updated?: string | null;
	snippet?: string;
	source?: "web" | "attachment";
}

export interface PerplexityCost {
	input_tokens_cost: number;
	output_tokens_cost: number;
	reasoning_tokens_cost?: number | null;
	request_cost?: number | null;
	citation_tokens_cost?: number | null;
	search_queries_cost?: number | null;
	total_cost: number;
}

export interface PerplexityUsageInfo {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	search_context_size?: string | null;
	citation_tokens?: number | null;
	num_search_queries?: number | null;
	reasoning_tokens?: number | null;
	cost: PerplexityCost;
}

export interface PerplexityMessageInput {
	role: PerplexityChatMessageRole;
	content: string | PerplexityContentChunk[] | null;
}

export interface PerplexityMessageOutput {
	role: PerplexityChatMessageRole;
	content: string | PerplexityContentChunk[] | null;
}

export interface PerplexitySearchOptions {
	search_context_size?: "low" | "medium" | "high";
	search_type?: "fast" | "pro" | "auto" | null;
}

export interface PerplexityRequest {
	max_tokens?: number | null;
	temperature?: number | null;
	model: string;
	stream?: boolean | null;
	messages: PerplexityMessageInput[];
	web_search_options?: PerplexitySearchOptions;
	search_mode?: "web" | "academic" | "sec" | null;
	return_related_questions?: boolean | null;
	num_search_results?: number;
	enable_search_classifier?: boolean | null;
	search_recency_filter?: "hour" | "day" | "week" | "month" | "year" | null;
	reasoning_effort?: "minimal" | "low" | "medium" | "high" | null;
	language_preference?: string | null;
}

export interface PerplexityChoice {
	index: number;
	finish_reason?: "stop" | "length" | null;
	message: PerplexityMessageOutput;
	delta: PerplexityMessageOutput;
}

export interface PerplexityResponse {
	id: string;
	model: string;
	created: number;
	usage?: PerplexityUsageInfo | null;
	object?: string;
	choices: PerplexityChoice[];
	citations?: string[] | null;
	search_results?: PerplexitySearchResult[] | null;
}
