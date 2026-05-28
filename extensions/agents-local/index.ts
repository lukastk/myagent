/**
 * AGENTS.local.md Extension
 *
 * Appends the content of an AGENTS.local.md file (if present alongside AGENTS.md
 * in the project directory) to the system prompt. This file is meant for personal
 * notes and memories that shouldn't be committed to the shared AGENTS.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Walk up from `startDir` to find a file named `filename`.
 * Stops at filesystem root. Returns the directory containing the file, or null.
 */
function findDirContaining(startDir: string, filename: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    const projectDir = findDirContaining(cwd, "AGENTS.md");
    if (!projectDir) return;

    const localFile = join(projectDir, "AGENTS.local.md");
    if (!existsSync(localFile)) return;

    let content: string;
    try {
      content = readFileSync(localFile, "utf8").trim();
    } catch {
      return;
    }

    if (!content) return;

    const header = "\n\n# Project AGENTS.local.md (personal notes/memories)\n";
    event.systemPrompt = (event.systemPrompt ?? "") + header + content;
  });
}
