/**
 * Web Tools Extension for Pi
 *
 * Provides three tools: web_search, browser, and fetch.
 * Transplanted from oh-my-pi's built-in web tools.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createWebSearchTool, setPreferredSearchProvider } from "./search/index.js";
import { createFetchTool } from "./fetch/index.js";
import { createBrowserTool } from "./browser/index.js";
import { SEARCH_SYSTEM_PROMPT } from "./prompts/search.js";

export default function (pi: ExtensionAPI) {
	// Register all three tools
	pi.registerTool(createWebSearchTool());
	pi.registerTool(createFetchTool(pi));

	const { tool: browserTool, cleanup: browserCleanup, setHeadless } = createBrowserTool(pi);
	pi.registerTool(browserTool);

	// System prompt injection
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + SEARCH_SYSTEM_PROMPT,
		};
	});

	// Slash commands
	pi.registerCommand("search-provider", {
		description: "Set preferred search provider (e.g. brave, tavily, auto)",
		handler: async (args, ctx) => {
			const provider = (args || "auto").toLowerCase().trim();
			setPreferredSearchProvider(provider as any);
			ctx.ui.notify(`Search provider set to: ${provider}`);
		},
	});

	let browserHeadless = true;
	pi.registerCommand("browser", {
		description: "Toggle browser headless/visible mode (browser, browser visible, browser headless)",
		handler: async (args, ctx) => {
			const arg = (args || "").toLowerCase().trim();
			if (arg === "visible" || arg === "show" || arg === "headful") {
				browserHeadless = false;
			} else if (arg === "headless" || arg === "hidden") {
				browserHeadless = true;
			} else {
				browserHeadless = !browserHeadless;
			}
			setHeadless(browserHeadless);
			ctx.ui.notify(`Browser mode: ${browserHeadless ? "headless" : "visible"}`);
		},
	});
}
