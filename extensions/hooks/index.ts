import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "hooks.json");
const PROJECT_CONFIG = join(".pi", "hooks.json");

interface HookEntry {
	/** Shell command, run via `bash -lc`. */
	command: string;
	/** Optional regex tested against the tool name (tool_call / tool_result only). */
	matcher?: string;
	/**
	 * When true the agent waits for the command to finish and honors its
	 * decision on blockable events. When false (default) the command is
	 * fire-and-forget and its exit code only affects logging.
	 */
	blocking?: boolean;
}

interface HooksConfig {
	hooks?: Record<string, HookEntry[]>;
}

/** Result of running a hook command. */
interface HookRun {
	code: number;
	stdout: string;
	stderr: string;
	/** Parsed stdout when it is valid JSON, else undefined. */
	json: Record<string, unknown> | undefined;
}

function readConfig(path: string): HooksConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as HooksConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`hooks: failed to parse ${path}: ${message}`);
		return {};
	}
}

/** Merge global then project hooks for a single event. */
function hooksForEvent(event: string, cwd: string): HookEntry[] {
	const global = readConfig(GLOBAL_CONFIG).hooks?.[event] ?? [];
	const project = readConfig(join(cwd, PROJECT_CONFIG)).hooks?.[event] ?? [];
	return [...global, ...project].filter(
		(h) => h && typeof h.command === "string",
	);
}

/** Filter tool hooks by their optional matcher regex against the tool name. */
function matches(entry: HookEntry, toolName: string | undefined): boolean {
	if (!entry.matcher) return true;
	if (toolName === undefined) return true;
	try {
		return new RegExp(entry.matcher).test(toolName);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`hooks: invalid matcher /${entry.matcher}/: ${message}`);
		return false;
	}
}

/** Environment exposed to every hook command, alongside the JSON stdin payload. */
function hookEnv(
	event: string,
	cwd: string,
	ctx: ExtensionContext,
	extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
	const sm = ctx.sessionManager;
	const base: Record<string, string | undefined> = {
		PI_EVENT: event,
		PI_CWD: cwd,
		PI_SESSION_ID: sm.getSessionId(),
		PI_SESSION_FILE: sm.getSessionFile(),
		PI_SESSION_DIR: sm.getSessionDir(),
		PI_SESSION_NAME: sm.getSessionName(),
		PI_LEAF_ID: sm.getLeafId() ?? undefined,
		PI_MODEL: ctx.model?.id,
		...extra,
	};
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function runHook(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	payload: Record<string, unknown>,
): Promise<HookRun> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (error) => {
			console.error(`hooks: error running "${command}": ${error.message}`);
			resolve({ code: 1, stdout: "", stderr: String(error), json: undefined });
		});
		child.on("close", (code, signal) => {
			const exit = signal ? 1 : (code ?? 1);
			let json: Record<string, unknown> | undefined;
			const trimmed = stdout.trim();
			if (trimmed.startsWith("{")) {
				try {
					json = JSON.parse(trimmed) as Record<string, unknown>;
				} catch {
					json = undefined;
				}
			}
			resolve({ code: exit, stdout, stderr, json });
		});
		try {
			child.stdin.write(JSON.stringify(payload));
			child.stdin.end();
		} catch {
			// stdin may already be closed; ignore.
		}
	});
}

/**
 * Describes how a single event maps onto the hook machinery: the JSON-safe
 * payload handed to each command, and (for blockable events) how a blocking
 * hook's result is turned into the value Pi expects back.
 */
interface EventSpec {
	payload: (event: any) => Record<string, unknown>;
	toolName?: (event: any) => string | undefined;
	/**
	 * Turn a blocking hook's result into a Pi event result. Returning a value
	 * with `block`/`cancel` truthy short-circuits the remaining hooks.
	 */
	decide?: (run: HookRun, event: any) => Record<string, unknown> | undefined;
}

const SPECS: Record<string, EventSpec> = {
	session_start: {
		payload: (e) => ({
			reason: e.reason,
			previousSessionFile: e.previousSessionFile,
		}),
	},
	session_shutdown: {
		payload: (e) => ({ reason: e.reason, targetSessionFile: e.targetSessionFile }),
	},
	agent_start: { payload: () => ({}) },
	agent_end: { payload: (e) => ({ messageCount: e.messages?.length ?? 0 }) },
	turn_start: { payload: (e) => ({ turnIndex: e.turnIndex }) },
	turn_end: { payload: (e) => ({ turnIndex: e.turnIndex }) },
	user_bash: {
		payload: (e) => ({
			command: e.command,
			excludeFromContext: e.excludeFromContext,
		}),
	},
	session_compact: { payload: (e) => ({ fromExtension: e.fromExtension }) },
	before_agent_start: {
		payload: (e) => ({ prompt: e.prompt, systemPrompt: e.systemPrompt }),
		decide: (run) =>
			typeof run.json?.systemPrompt === "string"
				? { systemPrompt: run.json.systemPrompt }
				: undefined,
	},
	tool_call: {
		payload: (e) => ({ toolName: e.toolName, input: e.input }),
		toolName: (e) => e.toolName,
		decide: (run) => {
			// Explicit JSON wins; otherwise a non-zero exit blocks.
			const blocked =
				run.json?.block === true || (run.json === undefined && run.code !== 0);
			if (!blocked) return undefined;
			const reason =
				(typeof run.json?.reason === "string" && run.json.reason) ||
				run.stderr.trim() ||
				run.stdout.trim() ||
				"blocked by hook";
			return { block: true, reason };
		},
	},
	tool_result: {
		payload: (e) => ({ toolName: e.toolName, isError: e.isError }),
		toolName: (e) => e.toolName,
		decide: (run) => {
			if (!run.json) return undefined;
			const result: Record<string, unknown> = {};
			if (Array.isArray(run.json.content)) result.content = run.json.content;
			if (typeof run.json.isError === "boolean") result.isError = run.json.isError;
			if ("details" in run.json) result.details = run.json.details;
			return Object.keys(result).length ? result : undefined;
		},
	},
	session_before_compact: {
		payload: () => ({}),
		decide: (run) => {
			const cancel =
				run.json?.cancel === true || (run.json === undefined && run.code !== 0);
			return cancel ? { cancel: true } : undefined;
		},
	},
};

export default function (pi: ExtensionAPI) {
	for (const [event, spec] of Object.entries(SPECS)) {
		pi.on(event as any, async (e: any, ctx: ExtensionContext) => {
			const cwd = ctx.cwd ?? process.cwd();
			const toolName = spec.toolName?.(e);
			const entries = hooksForEvent(event, cwd).filter((h) =>
				matches(h, toolName),
			);
			if (entries.length === 0) return;

			const payload = { event, cwd, ...spec.payload(e) };
			const env = hookEnv(event, cwd, ctx, { PI_TOOL_NAME: toolName });

			let result: Record<string, unknown> | undefined;
			for (const entry of entries) {
				if (!entry.blocking) {
					// Fire-and-forget: run, log failures, do not await.
					void runHook(entry.command, cwd, env, payload).then((run) => {
						if (run.code !== 0) {
							console.error(
								`hooks: ${event} hook failed (${run.code}): ${entry.command}`,
							);
						}
					});
					continue;
				}

				const run = await runHook(entry.command, cwd, env, payload);
				if (run.code !== 0 && !run.json) {
					console.error(
						`hooks: ${event} hook failed (${run.code}): ${entry.command}`,
					);
				}
				const decision = spec.decide?.(run, e);
				if (decision) {
					result = { ...result, ...decision };
					if (decision.block || decision.cancel) break;
				}
			}
			return result;
		});
	}
}
