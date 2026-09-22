import { AnthropicProvider } from "./providers/anthropic.js";
import type { SearchProvider } from "./providers/base.js";
import { BraveProvider } from "./providers/brave.js";
import { CodexProvider } from "./providers/codex.js";
import { ExaProvider } from "./providers/exa.js";
import { GeminiProvider } from "./providers/gemini.js";
import { JinaProvider } from "./providers/jina.js";
import { KagiProvider } from "./providers/kagi.js";
import { KimiProvider } from "./providers/kimi.js";
import { ParallelProvider } from "./providers/parallel.js";
import { PerplexityProvider } from "./providers/perplexity.js";
import { SyntheticProvider } from "./providers/synthetic.js";
import { TavilyProvider } from "./providers/tavily.js";
import { TinyFishProvider } from "./providers/tinyfish.js";
import { ZaiProvider } from "./providers/zai.js";
import { YouProvider } from "./providers/you.js";
import type { SearchProviderId } from "./types.js";

export type { SearchParams } from "./providers/base.js";
export { SearchProvider } from "./providers/base.js";

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
	exa: new ExaProvider(),
	brave: new BraveProvider(),
	tinyfish: new TinyFishProvider(),
	you: new YouProvider(),
	jina: new JinaProvider(),
	perplexity: new PerplexityProvider(),
	kimi: new KimiProvider(),
	zai: new ZaiProvider(),
	anthropic: new AnthropicProvider(),
	gemini: new GeminiProvider(),
	codex: new CodexProvider(),
	tavily: new TavilyProvider(),
	parallel: new ParallelProvider(),
	kagi: new KagiProvider(),
	synthetic: new SyntheticProvider(),
} as const;

// Prefer providers that expose structured source results. Providers whose primary
// response is a generated answer remain fallbacks rather than hiding source text
// behind synthesis in automatic mode.
export const SEARCH_PROVIDER_ORDER: SearchProviderId[] = [
	"brave",
	"exa",
	"parallel",
	"tinyfish",
	"kagi",
	"you",
	"synthetic",
	"jina",
	"kimi",
	"zai",
	"tavily",
	"perplexity",
	"anthropic",
	"gemini",
	"codex",
];

export function getSearchProvider(provider: SearchProviderId): SearchProvider {
	return SEARCH_PROVIDERS[provider];
}

/** Preferred provider for calls that omit `provider` (Brave by default). */
let preferredProvId: SearchProviderId | "auto" = "brave";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Read the current preferred web search provider. */
export function getPreferredSearchProvider(): SearchProviderId | "auto" {
	return preferredProvId;
}

/** Determine which providers are configured  */
export async function resolveProviderChain(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	if (preferredProvider !== "auto") {
		const provider = getSearchProvider(preferredProvider);
		return (await provider.isAvailable()) ? [provider] : [];
	}

	const providers: SearchProvider[] = [];
	for (const id of SEARCH_PROVIDER_ORDER) {
		const provider = getSearchProvider(id);
		if (await provider.isAvailable()) {
			providers.push(provider);
		}
	}

	return providers;
}
