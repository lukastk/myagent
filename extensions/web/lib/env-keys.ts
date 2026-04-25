/**
 * Environment-variable-based API key lookup.
 * Replaces oh-my-pi's getEnvApiKey + agent.db credential storage.
 */

const ENV_KEY_MAP: Record<string, string | string[]> = {
	brave: "BRAVE_API_KEY",
	exa: "EXA_API_KEY",
	tavily: "TAVILY_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	jina: "JINA_API_KEY",
	kimi: ["KIMI_SEARCH_API_KEY", "MOONSHOT_SEARCH_API_KEY"],
	google: "GEMINI_API_KEY",
	gemini: "GEMINI_API_KEY",
	openai: "OPENAI_API_KEY",
	"openai-codex": "OPENAI_API_KEY",
	zai: "ZAI_API_KEY",
	parallel: "PARALLEL_API_KEY",
	kagi: "KAGI_API_KEY",
	synthetic: "SYNTHETIC_API_KEY",
};

export function getEnvApiKey(provider: string): string | undefined {
	const envVar = ENV_KEY_MAP[provider];
	if (!envVar) return undefined;
	if (Array.isArray(envVar)) {
		for (const key of envVar) {
			const val = process.env[key];
			if (val) return val;
		}
		return undefined;
	}
	return process.env[envVar];
}
