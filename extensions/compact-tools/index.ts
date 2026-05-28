import type {
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionStartEvent,
	ToolRenderContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	type Component,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

type RenderTheme = {
	fg: (key: string, text: string) => string;
	bg: (key: string, text: string) => string;
	bold: (text: string) => string;
};

type ToolOutputRecord = {
	toolCallId: string;
	toolName: string;
	args: unknown;
	startedAt: number;
	updatedAt: number;
	output: string;
	isError: boolean;
	hasResult: boolean;
	preview: string;
	lineCount: number;
};

const compactToolNames = ["bash", "write", "find", "grep", "ls", "read", "edit"] as const;
type CompactToolName = (typeof compactToolNames)[number];

type CompactToolsConfig = {
	excludeTools?: CompactToolName[];
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const compactToolsConfigPath = join(extensionDir, "config.json");

function parseExcludedCompactTools(value: string | undefined): Set<CompactToolName> {
	const excluded = new Set<CompactToolName>();
	if (!value) return excluded;

	for (const token of value.split(/[\s,]+/)) {
		const name = token.trim().toLowerCase();
		if (!name) continue;
		if ((compactToolNames as readonly string[]).includes(name)) {
			excluded.add(name as CompactToolName);
		}
	}

	return excluded;
}

function readExcludedToolsFromConfig(): Set<CompactToolName> {
	if (!existsSync(compactToolsConfigPath)) return new Set();

	const raw = readFileSync(compactToolsConfigPath, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`compact-tools config is not valid JSON at ${compactToolsConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`compact-tools config at ${compactToolsConfigPath} must be a JSON object`);
	}

	const config = parsed as CompactToolsConfig;
	if (config.excludeTools === undefined) return new Set();
	if (!Array.isArray(config.excludeTools)) {
		throw new Error(`compact-tools config field "excludeTools" at ${compactToolsConfigPath} must be an array`);
	}

	const excluded = new Set<CompactToolName>();
	for (const name of config.excludeTools) {
		if (typeof name !== "string") {
			throw new Error(`compact-tools config field "excludeTools" at ${compactToolsConfigPath} must only contain strings`);
		}
		if (!(compactToolNames as readonly string[]).includes(name)) {
			throw new Error(
				`compact-tools config field "excludeTools" contains unsupported tool "${name}" at ${compactToolsConfigPath}. Supported tools: ${compactToolNames.join(", ")}`,
			);
		}
		excluded.add(name as CompactToolName);
	}

	return excluded;
}

function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function getTextContent(result: {
	content: Array<{ type: string; text?: string }>;
}): string | undefined {
	const textBlock = result.content.find((block) => block.type === "text");
	if (!textBlock || textBlock.type !== "text") return undefined;
	return textBlock.text;
}

function getAllTextContent(content: Array<{ type: string; text?: string }>): string {
	const lines: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			lines.push(block.text);
		}
	}
	return lines.join("\n");
}

function countNonEmptyLines(text: string): number {
	if (!text.trim()) return 0;
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function previewText(text: string, max = 72): string {
	const cleaned = sanitizePaneLine(text);
	const first = firstNonEmptyLine(cleaned);
	if (!first) return "(no text output)";
	if (first.length <= max) return first;
	return `${first.slice(0, max - 1)}…`;
}

function formatArgsForDisplay(args: unknown): string[] {
	if (args === undefined) return ["(arguments unavailable)"];
	if (typeof args === "string") return args.length > 0 ? [args] : ["(empty string)"];
	if (typeof args === "number" || typeof args === "boolean") return [String(args)];
	if (args === null) return ["null"];
	try {
		const json = JSON.stringify(args, null, 2);
		if (!json) return ["(no arguments)"];
		return json.split("\n");
	} catch {
		return [String(args)];
	}
}

function sanitizePaneLine(text: string): string {
	let cleaned = text;
	// OSC sequences (e.g. hyperlinks): ESC ] ... BEL or ESC \\
	cleaned = cleaned.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
	// CSI sequences: ESC [ ... final
	cleaned = cleaned.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	// Single-character ESC sequences
	cleaned = cleaned.replace(/\x1B[@-Z\\-_]/g, "");
	// Other control chars except newline/tab (newlines are split before this function)
	cleaned = cleaned.replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, "");
	// Make tab width deterministic for the TUI width checks
	cleaned = cleaned.replace(/\t/g, "    ");
	return cleaned;
}

function highlightIfSelected(text: string, theme: RenderTheme, selected: boolean): string {
	if (!selected) return text;
	return theme.bg("selectedBg", text);
}

function renderExpandedText(
	result: { content: Array<{ type: string; text?: string }> },
	theme: RenderTheme,
): Text {
	const text = getTextContent(result);
	if (!text) return new Text("", 0, 0);

	const output = text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");

	if (!output.trim()) return new Text("", 0, 0);
	return new Text(`\n${output}`, 0, 0);
}

function renderCollapsedErrorOrSummary(
	result: { content: Array<{ type: string; text?: string }> },
	isError: boolean,
	theme: RenderTheme,
	summaryText: string,
	selected: boolean,
): Text {
	if (!isError) return new Text(highlightIfSelected(theme.fg("muted", summaryText), theme, selected), 0, 0);

	const text = getTextContent(result);
	const firstLine = text?.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) return new Text(highlightIfSelected(theme.fg("error", " → failed"), theme, selected), 0, 0);

	return new Text(highlightIfSelected(theme.fg("error", ` → ${firstLine}`), theme, selected), 0, 0);
}

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function toToolExecutionLabel(record: ToolOutputRecord): string {
	const lineLabel = record.lineCount === 1 ? "line" : "lines";
	const status = record.isError ? "error" : "ok";
	return `${record.toolName} • ${record.preview} (${record.lineCount} ${lineLabel}, ${status})`;
}

class ToolOutputSplitPane implements Component {
	private scrollOffset = 0;
	private wrappedCache = new Map<string, { width: number; lines: string[] }>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: RenderTheme,
		private readonly getRecords: () => ToolOutputRecord[],
		private readonly getSelectedToolCallId: () => string | undefined,
		private readonly setSelectedToolCallId: (toolCallId: string) => void,
		private readonly onClose: () => void,
		private readonly onSelectionChanged: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "ctrl+alt+o")) {
			this.onClose();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.alt("left"))) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, Key.right) || matchesKey(data, Key.alt("right"))) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.scrollOffset += 1;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 12);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += 12;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.end)) {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.wrappedCache.clear();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(16, width);
		const records = this.getRecords();
		if (records.length === 0) {
			return [
				truncateToWidth(this.theme.fg("warning", "No tool outputs yet."), safeWidth, ""),
				truncateToWidth(
					this.theme.fg("dim", "Run a compact tool, then open the pane again."),
					safeWidth,
					"",
				),
			];
		}

		let selectedId = this.getSelectedToolCallId();
		if (!selectedId || !records.some((record) => record.toolCallId === selectedId)) {
			selectedId = records[records.length - 1]?.toolCallId;
			if (selectedId) {
				this.setSelectedToolCallId(selectedId);
				this.onSelectionChanged();
			}
		}

		const selectedIndex = Math.max(
			0,
			records.findIndex((record) => record.toolCallId === selectedId),
		);
		const selected = records[selectedIndex] ?? records[0]!;
		const bodyLines = this.getWrappedBodyLines(selected, safeWidth);

		const terminalRows = this.tui.terminal.rows || 24;
		const headerRows = 4;
		const footerRows = 2;
		const visibleRows = Math.max(4, Math.floor(terminalRows * 0.8) - headerRows - footerRows);
		const maxScroll = Math.max(0, bodyLines.length - visibleRows);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		if (this.scrollOffset < 0) this.scrollOffset = 0;

		const bodySlice = bodyLines.slice(this.scrollOffset, this.scrollOffset + visibleRows);
		while (bodySlice.length < visibleRows) bodySlice.push("");

		const divider = this.theme.fg("border", "─".repeat(safeWidth));
		const title = this.theme.fg("accent", this.theme.bold(`Tool output ${selectedIndex + 1}/${records.length}`));
		const subtitleColor = selected.isError ? "error" : "muted";
		const subtitle = this.theme.fg(subtitleColor, toToolExecutionLabel(selected));
		const help = this.theme.fg("dim", "←/→ switch  ↑/↓/PgUp/PgDn scroll  Home/End  Esc close");

		const top = [title, subtitle, help, divider].map((line) => truncateToWidth(line, safeWidth, ""));
		const bottomInfo = this.theme.fg(
			"dim",
			`lines ${Math.min(bodyLines.length, this.scrollOffset + 1)}-${Math.min(
				bodyLines.length,
				this.scrollOffset + bodySlice.length,
			)} / ${bodyLines.length}`,
		);
		const bottom = [divider, truncateToWidth(bottomInfo, safeWidth, "")];

		return [...top, ...bodySlice.map((line) => truncateToWidth(line, safeWidth, "")), ...bottom];
	}

	private moveSelection(delta: number): void {
		const records = this.getRecords();
		if (records.length === 0) return;

		const selectedId = this.getSelectedToolCallId();
		const currentIndex = Math.max(
			0,
			records.findIndex((record) => record.toolCallId === selectedId),
		);
		const nextIndex = Math.min(records.length - 1, Math.max(0, currentIndex + delta));
		if (nextIndex === currentIndex) return;

		const next = records[nextIndex];
		if (!next) return;

		this.setSelectedToolCallId(next.toolCallId);
		this.scrollOffset = 0;
		this.onSelectionChanged();
		this.tui.requestRender();
	}

	private getWrappedBodyLines(record: ToolOutputRecord, width: number): string[] {
		const cached = this.wrappedCache.get(record.toolCallId);
		if (cached && cached.width === width) return cached.lines;

		const outputLines = record.output.length > 0 ? record.output.split("\n") : ["(no text output)"];
		const invocationLines = formatArgsForDisplay(record.args);
		type PaneLine = { text: string; style: "heading" | "label" | "content" | "spacer" };
		const sourceLines: PaneLine[] = [
			{ text: "Invocation", style: "heading" },
			{ text: `tool: ${record.toolName}`, style: "label" },
			{ text: "arguments:", style: "label" },
			...invocationLines.map((line) => ({ text: line, style: "content" as const })),
			{ text: "", style: "spacer" },
			{ text: "Output", style: "heading" },
			...outputLines.map((line) => ({ text: line, style: "content" as const })),
		];

		const wrapped: string[] = [];
		for (const line of sourceLines) {
			const source = sanitizePaneLine(line.text.length === 0 ? " " : line.text);
			const styled =
				line.style === "heading"
					? this.theme.fg("accent", this.theme.bold(source))
					: line.style === "label"
						? this.theme.fg("muted", source)
						: source;
			const chunks = wrapTextWithAnsi(styled, width);
			if (chunks.length === 0) {
				wrapped.push("");
				continue;
			}
			wrapped.push(...chunks);
		}

		this.wrappedCache.set(record.toolCallId, { width, lines: wrapped });
		return wrapped;
	}
}

export default function (pi: ExtensionAPI) {
	const overrideReadEdit =
		process.env.PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT === "1" ||
		process.env.PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT === "true";
	const configExcludedToolNames = readExcludedToolsFromConfig();
	const envExcludedToolNames = parseExcludedCompactTools(process.env.PI_COMPACT_TOOLS_EXCLUDE_TOOLS);
	const excludedToolNames = new Set<CompactToolName>([...configExcludedToolNames, ...envExcludedToolNames]);

	const trackedToolNames = new Set(compactToolNames.filter((name) => !excludedToolNames.has(name)));

	const toolOutputs: ToolOutputRecord[] = [];
	const toolOutputsById = new Map<string, ToolOutputRecord>();
	const rowInvalidators = new Map<string, () => void>();
	let selectedToolCallId: string | undefined;
	let paneOpen = false;
	let closePane: (() => void) | undefined;

	function isToolSelected(toolCallId: string): boolean {
		return paneOpen && selectedToolCallId === toolCallId;
	}

	function registerRowInvalidator(toolCallId: string, invalidate: () => void): void {
		rowInvalidators.set(toolCallId, invalidate);
	}

	function invalidateToolRow(toolCallId: string): void {
		const invalidate = rowInvalidators.get(toolCallId);
		if (!invalidate) return;
		try {
			invalidate();
		} catch {
			// Ignore stale invalidators from previous renders.
		}
	}

	function invalidateAllRows(): void {
		for (const toolCallId of rowInvalidators.keys()) {
			invalidateToolRow(toolCallId);
		}
	}

	function setSelectedToolCallId(toolCallId: string | undefined): void {
		if (selectedToolCallId === toolCallId) return;
		const previous = selectedToolCallId;
		selectedToolCallId = toolCallId;
		if (previous) invalidateToolRow(previous);
		if (toolCallId) invalidateToolRow(toolCallId);
	}

	function getCompletedToolOutputs(): ToolOutputRecord[] {
		return toolOutputs.filter((record) => record.hasResult);
	}

	function ensureToolOutputRecord(event: ToolExecutionStartEvent | ToolResultEvent): ToolOutputRecord {
		let record = toolOutputsById.get(event.toolCallId);
		if (record) return record;

		record = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: "args" in event ? event.args : event.input,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			output: "",
			isError: false,
			hasResult: false,
			preview: "(pending)",
			lineCount: 0,
		};
		toolOutputs.push(record);
		toolOutputsById.set(record.toolCallId, record);
		return record;
	}


	function collectToolArgumentsFromSession(ctx: ExtensionContext): Map<string, unknown> {
		const toolArgumentsByCallId = new Map<string, unknown>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;

			const message = entry.message as {
				role?: string;
				content?: Array<{ type?: string; id?: string; arguments?: unknown }>;
			};
			if (message.role !== "assistant") continue;
			if (!Array.isArray(message.content)) continue;

			for (const block of message.content) {
				if (!block || block.type !== "toolCall") continue;
				if (typeof block.id !== "string") continue;
				toolArgumentsByCallId.set(block.id, block.arguments);
			}
		}
		return toolArgumentsByCallId;
	}

	function rebuildToolOutputsFromSession(ctx: ExtensionContext): void {
		const toolArgumentsByCallId = collectToolArgumentsFromSession(ctx);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;

			const message = entry.message as {
				role?: string;
				toolCallId?: string;
				toolName?: string;
				content?: Array<{ type: string; text?: string }>;
				isError?: boolean;
				timestamp?: number;
			};

			if (message.role !== "toolResult") continue;
			if (typeof message.toolName !== "string" || !trackedToolNames.has(message.toolName)) continue;

			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : `restored-${entry.id}`;
			if (toolOutputsById.has(toolCallId)) continue;

			const content = Array.isArray(message.content) ? message.content : [];
			const output = getAllTextContent(content);
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();

			const record: ToolOutputRecord = {
				toolCallId,
				toolName: message.toolName,
				args: toolArgumentsByCallId.get(toolCallId),
				startedAt: timestamp,
				updatedAt: timestamp,
				output,
				isError: Boolean(message.isError),
				hasResult: true,
				preview: previewText(output),
				lineCount: countNonEmptyLines(output),
			};

			toolOutputs.push(record);
			toolOutputsById.set(toolCallId, record);
		}

		if (!selectedToolCallId && toolOutputs.length > 0) {
			selectedToolCallId = toolOutputs[toolOutputs.length - 1]?.toolCallId;
		}
	}

	function getCallPrefix(toolCallId: string, text: string, theme: RenderTheme): string {
		const selected = isToolSelected(toolCallId);
		if (!selected) return text;
		return highlightIfSelected(`▶ ${text}`, theme, true);
	}

	function trackRenderContext(context: ToolRenderContext): void {
		registerRowInvalidator(context.toolCallId, context.invalidate);
	}

	async function openSplitPane(ctx: ExtensionContext): Promise<void> {
		const records = getCompletedToolOutputs();
		if (records.length === 0) {
			ctx.ui.notify("No compact tool outputs available yet.", "info");
			return;
		}
		if (paneOpen) return;

		paneOpen = true;
		if (!selectedToolCallId || !records.some((record) => record.toolCallId === selectedToolCallId)) {
			setSelectedToolCallId(records[records.length - 1]?.toolCallId);
		}
		invalidateAllRows();

		let closed = false;
		const finalizeClosedState = (): boolean => {
			if (closed) return false;
			closed = true;
			paneOpen = false;
			closePane = undefined;
			return true;
		};

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const requestClose = () => {
						if (!finalizeClosedState()) return;
						done();
					};
					closePane = requestClose;
					return new ToolOutputSplitPane(
						tui,
						theme,
						() => getCompletedToolOutputs(),
						() => selectedToolCallId,
						(toolCallId) => setSelectedToolCallId(toolCallId),
						requestClose,
						() => invalidateAllRows(),
					);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "45%",
						minWidth: 52,
						maxHeight: "100%",
						margin: { top: 1, right: 1, bottom: 1, left: 0 },
					},
				},
			);
		} finally {
			finalizeClosedState();
			setSelectedToolCallId(undefined);
			invalidateAllRows();
		}
	}

	async function toggleSplitPane(ctx: ExtensionContext): Promise<void> {
		if (paneOpen) {
			if (closePane) {
				closePane();
			} else {
				ctx.ui.notify("Tool output pane is opening…", "info");
			}
			return;
		}
		await openSplitPane(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		toolOutputs.length = 0;
		toolOutputsById.clear();
		rowInvalidators.clear();
		selectedToolCallId = undefined;
		paneOpen = false;
		closePane = undefined;
		rebuildToolOutputsFromSession(ctx);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!trackedToolNames.has(event.toolName)) return;
		ensureToolOutputRecord(event);
	});

	pi.on("tool_result", async (event) => {
		if (!trackedToolNames.has(event.toolName)) return;
		const record = ensureToolOutputRecord(event);
		record.output = getAllTextContent(event.content as Array<{ type: string; text?: string }>);
		record.isError = event.isError;
		record.hasResult = true;
		record.updatedAt = Date.now();
		record.lineCount = countNonEmptyLines(record.output);
		record.preview = previewText(record.output);
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Toggle compact tool split pane",
		handler: async (ctx) => {
			await toggleSplitPane(ctx);
		},
	});

	pi.registerCommand("tool-pane", {
		description: "Toggle compact tool split pane",
		handler: async (_args, ctx) => {
			await toggleSplitPane(ctx);
		},
	});

	if (overrideReadEdit && trackedToolNames.has("read")) {
		pi.registerTool({
			name: "read",
			label: "read",
			description:
				"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
			parameters: getBuiltInTools(process.cwd()).read.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, renderContext) {
				trackRenderContext(renderContext);
				const path = shortenPath(args.path || "");
				let text = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}`;
				if (args.offset !== undefined || args.limit !== undefined) {
					const startLine = args.offset ?? 1;
					const endLine = args.limit !== undefined ? startLine + args.limit - 1 : undefined;
					text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
				}
				return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
			},
			renderResult(result, { expanded }, theme, renderContext) {
				trackRenderContext(renderContext);
				if (expanded) return renderExpandedText(result, theme);
				const lineCount = countNonEmptyLines(getTextContent(result) || "");
				const summary = lineCount > 0 ? ` → ${lineCount} lines` : "";
				return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, summary, isToolSelected(renderContext.toolCallId));
			},
		});
	}

	if (trackedToolNames.has("bash")) {
		pi.registerTool({
			name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, renderContext) {
			trackRenderContext(renderContext);
			const command = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			const text = theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix;
			return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme, renderContext) {
			trackRenderContext(renderContext);
			if (expanded) return renderExpandedText(result, theme);
			const lineCount = countNonEmptyLines(getTextContent(result) || "");
			const summary = lineCount > 0 ? ` → ${lineCount} lines` : "";
			return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, summary, isToolSelected(renderContext.toolCallId));
		},
		});
	}

	if (trackedToolNames.has("write")) {
		pi.registerTool({
			name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, renderContext) {
			trackRenderContext(renderContext);
			const path = shortenPath(args.path || "");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			let text = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}`;
			if (lineCount > 0) text += theme.fg("muted", ` (${lineCount} lines)`);
			return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme, renderContext) {
			trackRenderContext(renderContext);
			if (expanded) return renderExpandedText(result, theme);
			return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, " → wrote", isToolSelected(renderContext.toolCallId));
		},
		});
	}

	if (overrideReadEdit && trackedToolNames.has("edit")) {
		pi.registerTool({
			name: "edit",
			label: "edit",
			description:
				"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
			parameters: getBuiltInTools(process.cwd()).edit.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme, renderContext) {
				trackRenderContext(renderContext);
				const path = shortenPath(args.path || "");
				const text = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}`;
				return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
			},
			renderResult(result, { expanded }, theme, renderContext) {
				trackRenderContext(renderContext);
				if (expanded) return renderExpandedText(result, theme);
				return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, " → updated", isToolSelected(renderContext.toolCallId));
			},
		});
	}

	if (trackedToolNames.has("find")) {
		pi.registerTool({
			name: "find",
		label: "find",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: getBuiltInTools(process.cwd()).find.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, renderContext) {
			trackRenderContext(renderContext);
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${path}`)}`;
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme, renderContext) {
			trackRenderContext(renderContext);
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} files` : "";
			return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, summary, isToolSelected(renderContext.toolCallId));
		},
		});
	}

	if (trackedToolNames.has("grep")) {
		pi.registerTool({
			name: "grep",
		label: "grep",
		description:
			"Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 200 matches.",
		parameters: getBuiltInTools(process.cwd()).grep.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, renderContext) {
			trackRenderContext(renderContext);
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("toolOutput", ` in ${path}`)}`;
			if (args.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme, renderContext) {
			trackRenderContext(renderContext);
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} matches` : "";
			return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, summary, isToolSelected(renderContext.toolCallId));
		},
		});
	}

	if (trackedToolNames.has("ls")) {
		pi.registerTool({
			name: "ls",
		label: "ls",
		description:
			"List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
		parameters: getBuiltInTools(process.cwd()).ls.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, renderContext) {
			trackRenderContext(renderContext);
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(getCallPrefix(renderContext.toolCallId, text, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme, renderContext) {
			trackRenderContext(renderContext);
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} entries` : "";
			return renderCollapsedErrorOrSummary(result, renderContext.isError, theme, summary, isToolSelected(renderContext.toolCallId));
		},
		});
	}
}
