/**
 * Search-provider credential lookup.
 *
 * Environment variables remain the first source. When a Pi process was started by
 * a long-lived service (notably a sesh headless worker), the service deliberately
 * does not inherit on-demand 1Password secrets. In that case we ask the rig's
 * `secret` command for search credentials at first use and retain them only in this
 * extension's memory; they are never exported into Pi's process environment.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SECRET_COMMAND_TIMEOUT_MS = 15_000;

const ENV_KEY_MAP: Record<string, string | string[]> = {
	brave: "BRAVE_API_KEY",
	exa: "EXA_API_KEY",
	tavily: "TAVILY_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	// These canonical names are deliberately renamed in the mysetup vault so
	// Claude Code and Codex do not auto-detect API-key authentication.
	anthropic: ["ANTHROPIC_API_KEY", "MY_ANTHROPIC_API_KEY"],
	jina: "JINA_API_KEY",
	kimi: ["KIMI_SEARCH_API_KEY", "MOONSHOT_SEARCH_API_KEY"],
	google: "GEMINI_API_KEY",
	gemini: "GEMINI_API_KEY",
	openai: ["OPENAI_API_KEY", "MY_OPENAI_API_KEY"],
	"openai-codex": ["OPENAI_API_KEY", "MY_OPENAI_API_KEY"],
	zai: "ZAI_API_KEY",
	parallel: "PARALLEL_API_KEY",
	kagi: "KAGI_API_KEY",
	synthetic: "SYNTHETIC_API_KEY",
};

const loadedSecretValues = new Map<string, string>();
let credentialLoadPromise: Promise<void> | undefined;

function credentialNames(): string[] {
	return [...new Set(Object.values(ENV_KEY_MAP).flat())];
}

function configuredEnvironmentValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

function parseSecretInventory(stdout: string): Set<string> {
	const knownNames = new Set(credentialNames());
	const available = new Set<string>();
	for (const line of stdout.split("\n")) {
		const name = line.trim().split(/\s+/, 1)[0];
		if (name && knownNames.has(name)) available.add(name);
	}
	return available;
}

async function runSecret(args: string[]): Promise<string> {
	const result = await execFileAsync("secret", args, {
		encoding: "utf8",
		timeout: SECRET_COMMAND_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
	});
	return result.stdout;
}

async function loadCredentialsFromSecret(): Promise<void> {
	let inventory: string;
	try {
		inventory = await runSecret(["list"]);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			// `secret` is mysetup-specific; ordinary Pi installs can use env vars only.
			return;
		}
		throw new Error(
			`Failed to list search credentials through secret: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const available = parseSecretInventory(inventory);
	const namesToLoad = [...available].filter(name => !process.env[name]);
	const resolved = await Promise.all(
		namesToLoad.map(async name => {
			let value: string;
			try {
				value = (await runSecret(["get", name])).trim();
			} catch (error) {
				throw new Error(
					`Failed to retrieve ${name} through secret: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!value) throw new Error(`secret returned an empty value for ${name}`);
			return [name, value] as const;
		}),
	);

	for (const [name, value] of resolved) loadedSecretValues.set(name, value);
}

/** Load on-demand rig credentials once, immediately before the first search. */
export async function ensureSearchProviderCredentials(): Promise<void> {
	if (!credentialLoadPromise) {
		credentialLoadPromise = loadCredentialsFromSecret().catch(error => {
			credentialLoadPromise = undefined;
			throw error;
		});
	}
	await credentialLoadPromise;
}

export function getEnvApiKey(provider: string): string | undefined {
	const envVar = ENV_KEY_MAP[provider];
	if (!envVar) return undefined;
	const names = Array.isArray(envVar) ? envVar : [envVar];
	return (
		configuredEnvironmentValue(names) ?? names.map(name => loadedSecretValues.get(name)).find(Boolean)
	);
}
