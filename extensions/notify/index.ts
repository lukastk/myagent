import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GLOBAL_HOOKS_FILE = join(homedir(), ".pi", "agent", "agent_end_hooks.txt");
const PROJECT_HOOKS_FILE = join(".pi", "agent_end_hooks.txt");

function parseCommands(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function readHookFile(path: string): string[] {
	if (!existsSync(path)) return [];
	return parseCommands(readFileSync(path, "utf8"));
}

async function runCommand(command: string, cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: "ignore" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) return resolve(1);
			resolve(code ?? 1);
		});
	});
}

function getAgentEndCommands(cwd: string): string[] {
	const projectHooksFile = join(cwd, PROJECT_HOOKS_FILE);
	const fromEnv = parseCommands(process.env.PI_AGENT_END_HOOKS || "");
	const merged = [
		...readHookFile(GLOBAL_HOOKS_FILE),
		...readHookFile(projectHooksFile),
		...fromEnv,
	];
	return [...new Set(merged)];
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async () => {
		const cwd = process.cwd();
		const commands = getAgentEndCommands(cwd);

		for (const command of commands) {
			try {
				const code = await runCommand(command, cwd);
				if (code !== 0) {
					console.error(`agent_end hook failed (${code}): ${command}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`agent_end hook error: ${message}`);
			}
		}
	});
}
