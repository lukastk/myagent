/**
 * Web Tools Extension for Pi
 *
 * Provides three tools: web_search, browser, and fetch.
 * Transplanted from oh-my-pi's built-in web tools.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createFetchTool } from "./fetch/index.js";
import { createBrowserTool } from "./browser/index.js";
import { SEARCH_SYSTEM_PROMPT } from "./prompts/search.js";
import { createWebSearchTool } from "./search/index.js";
import {
	getPreferredSearchProvider,
	getSearchProvider,
	resolveProviderChain,
	SEARCH_PROVIDER_ORDER,
	setPreferredSearchProvider,
} from "./search/provider.js";
import { isSearchProviderPreference, type SearchProviderId } from "./search/types.js";

type SearchProviderPreference = SearchProviderId | "auto";

function formatProviderChoice(provider: SearchProviderPreference): string {
	if (provider === "auto") return "Auto";

	const searchProvider = getSearchProvider(provider);
	return `${searchProvider.label} (${provider})`;
}

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
		description: "Choose the preferred web search provider",
		handler: async (args, ctx) => {
			const requestedProvider = args?.toLowerCase().trim();

			if (requestedProvider) {
				if (!isSearchProviderPreference(requestedProvider)) {
					ctx.ui.notify(
						`Unknown search provider: ${requestedProvider}. Run /search-provider to choose from the menu.`,
						"error",
					);
					return;
				}

				setPreferredSearchProvider(requestedProvider);
				ctx.ui.notify(`Search provider set to: ${formatProviderChoice(requestedProvider)}`);
				return;
			}

			const currentProvider = getPreferredSearchProvider();
			const autoChain = await resolveProviderChain("auto");
			const autoDescription =
				autoChain.length > 0
					? `configured fallback: ${autoChain.map(provider => provider.label).join(" → ")}`
					: "no configured providers";

			const menuItems: Array<{ id: SearchProviderId | "auto"; label: string }> = [
				{
					id: "auto",
					label: `${currentProvider === "auto" ? "✓" : " "} Auto — ${autoDescription}`,
				},
			];

			for (const id of SEARCH_PROVIDER_ORDER) {
				const provider = getSearchProvider(id);
				const status = (await provider.isAvailable()) ? "configured" : "not configured";
				menuItems.push({
					id,
					label: `${currentProvider === id ? "✓" : " "} ${provider.label} (${id}) — ${status}`,
				});
			}

			const selectedLabel = await ctx.ui.select(
				"Choose web search provider",
				menuItems.map(item => item.label),
			);
			if (!selectedLabel) return;

			const selectedItem = menuItems.find(item => item.label === selectedLabel);
			if (!selectedItem) {
				throw new Error(`Search provider menu returned an unknown selection: ${selectedLabel}`);
			}

			setPreferredSearchProvider(selectedItem.id);
			ctx.ui.notify(`Search provider set to: ${formatProviderChoice(selectedItem.id)}`);
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
