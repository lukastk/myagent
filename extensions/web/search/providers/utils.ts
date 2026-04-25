import type { SearchSource } from "../types.js";
import { dateToAgeSeconds } from "../utils.js";

/**
 * Simplified credential lookup: just return the env key value (or null).
 * In oh-my-pi this also checked agent.db — here we only use env vars.
 */
export async function findCredential(envKey: string | null | undefined): Promise<string | null> {
	return envKey || null;
}

/**
 * Probe whether a provider's API key lookup resolves to a truthy value.
 * Swallows lookup errors and reports unavailability.
 */
export async function isApiKeyAvailable(findApiKey: () => string | null | Promise<string | null>) {
	try {
		return !!(await findApiKey());
	} catch {
		return false;
	}
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}
