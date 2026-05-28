import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type BarrelItem = {
	id: string;
	text: string;
	createdAt: number;
};

type BarrelStateEntry = {
	items?: unknown;
};

const BARREL_STATE_TYPE = "message-barrel-state";

function preview(text: string, max = 72): string {
	const firstNonEmpty = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const line = firstNonEmpty ?? text.trim();
	if (line.length <= max) return line;
	return `${line.slice(0, max - 1)}…`;
}

function formatOption(index: number, item: BarrelItem): string {
	const p = preview(item.text) || "(empty)";
	const lineCount = item.text.split("\n").length;
	const lineLabel = lineCount === 1 ? "line" : "lines";
	return `[${index + 1}] ${p} (${lineCount} ${lineLabel})`;
}

function parseSelectedIndex(option: string): number | undefined {
	const match = option.match(/^\[(\d+)\]/);
	if (!match) return undefined;
	const idx = Number.parseInt(match[1], 10) - 1;
	if (!Number.isInteger(idx) || idx < 0) return undefined;
	return idx;
}

function asBarrelItems(value: unknown): BarrelItem[] {
	if (!Array.isArray(value)) return [];

	const items: BarrelItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Partial<BarrelItem>;
		if (typeof candidate.text !== "string") continue;
		if (typeof candidate.id !== "string") continue;
		if (typeof candidate.createdAt !== "number") continue;
		items.push({ id: candidate.id, text: candidate.text, createdAt: candidate.createdAt });
	}
	return items;
}

export default function (pi: ExtensionAPI) {
	let barrel: BarrelItem[] = [];

	function persist(): void {
		pi.appendEntry(BARREL_STATE_TYPE, {
			items: barrel,
		} satisfies BarrelStateEntry);
	}

	function updateBarrelWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (barrel.length === 0) {
			ctx.ui.setWidget("message-barrel-indicator", undefined);
			return;
		}

		const itemLabel = barrel.length === 1 ? "message" : "messages";
		ctx.ui.setWidget(
			"message-barrel-indicator",
			[
				ctx.ui.theme.fg("warning", `⚠ ${barrel.length} ${itemLabel} in barrel`),
				ctx.ui.theme.fg("muted", "Press Ctrl+Alt+B or run /barrel to paste"),
			],
			{ placement: "belowEditor" },
		);
	}

	function saveTextToBarrel(text: string, ctx: ExtensionContext): boolean {
		if (!text.trim()) {
			ctx.ui.notify("Editor is empty. Nothing saved to barrel.", "warning");
			return false;
		}

		const item: BarrelItem = {
			id: randomUUID(),
			text,
			createdAt: Date.now(),
		};
		barrel.push(item);
		persist();
		updateBarrelWidget(ctx);

		ctx.ui.notify(`Saved to barrel: ${preview(text)}`, "info");
		return true;
	}

	async function pickAndPasteFromBarrel(ctx: ExtensionContext): Promise<void> {
		if (barrel.length === 0) {
			ctx.ui.notify("Barrel is empty.", "warning");
			return;
		}

		const options = barrel.map((item, index) => formatOption(index, item));
		const selected = await ctx.ui.select("Paste message from barrel", options);
		if (!selected) return;

		const selectedIndex = parseSelectedIndex(selected);
		if (selectedIndex === undefined || selectedIndex >= barrel.length) {
			ctx.ui.notify("Could not resolve selected barrel item.", "error");
			return;
		}

		const item = barrel[selectedIndex];
		barrel.splice(selectedIndex, 1);
		persist();
		updateBarrelWidget(ctx);

		ctx.ui.pasteToEditor(item.text);
		ctx.ui.notify("Pasted barrel message into editor.", "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		const entry = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === BARREL_STATE_TYPE)
			.pop();

		barrel = asBarrelItems((entry?.data as BarrelStateEntry | undefined)?.items);
		updateBarrelWidget(ctx);
	});
	function saveCurrentEditorToBarrel(ctx: ExtensionContext): void {
		const text = ctx.ui.getEditorText();
		const saved = saveTextToBarrel(text, ctx);
		if (saved) {
			ctx.ui.setEditorText("");
		}
	}

	pi.registerShortcut("ctrl+alt+n", {
		description: "Save editor text to message barrel",
		handler: async (ctx) => {
			saveCurrentEditorToBarrel(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+b", {
		description: "Pick and paste a message from barrel",
		handler: async (ctx) => {
			await pickAndPasteFromBarrel(ctx);
		},
	});


	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("message-barrel-indicator", undefined);
	});

	pi.registerCommand("barrel", {
		description: "Paste a saved message from the barrel into editor",
		handler: async (_args, ctx) => {
			await pickAndPasteFromBarrel(ctx);
		},
	});

	pi.registerCommand("barrel-save", {
		description: "Save current editor text to the barrel",
		handler: async (_args, ctx) => {
			saveCurrentEditorToBarrel(ctx);
		},
	});
}
