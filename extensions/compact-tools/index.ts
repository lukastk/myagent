import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

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

function countNonEmptyLines(text: string): number {
	if (!text.trim()) return 0;
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function renderExpandedText(
	result: { content: Array<{ type: string; text?: string }> },
	theme: { fg: (key: string, text: string) => string },
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
	theme: { fg: (key: string, text: string) => string },
	summaryText: string,
): Text {
	if (!isError) return new Text(theme.fg("muted", summaryText), 0, 0);

	const text = getTextContent(result);
	const firstLine = text?.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) return new Text(theme.fg("error", " → failed"), 0, 0);

	return new Text(theme.fg("error", ` → ${firstLine}`), 0, 0);
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

export default function (pi: ExtensionAPI) {
	const overrideReadEdit =
		process.env.PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT === "1" ||
		process.env.PI_COMPACT_TOOLS_OVERRIDE_READ_EDIT === "true";

	if (overrideReadEdit) {
		pi.registerTool({
			name: "read",
			label: "read",
			description:
				"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
			parameters: getBuiltInTools(process.cwd()).read.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				const path = shortenPath(args.path || "");
				let text = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}`;
				if (args.offset !== undefined || args.limit !== undefined) {
					const startLine = args.offset ?? 1;
					const endLine = args.limit !== undefined ? startLine + args.limit - 1 : undefined;
					text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
				}
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded }, theme, context) {
				if (expanded) return renderExpandedText(result, theme);
				const lineCount = countNonEmptyLines(getTextContent(result) || "");
				const summary = lineCount > 0 ? ` → ${lineCount} lines` : "";
				return renderCollapsedErrorOrSummary(result, context.isError, theme, summary);
			},
		});
	}

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const command = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			const lineCount = countNonEmptyLines(getTextContent(result) || "");
			const summary = lineCount > 0 ? ` → ${lineCount} lines` : "";
			return renderCollapsedErrorOrSummary(result, context.isError, theme, summary);
		},
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			let text = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}`;
			if (lineCount > 0) text += theme.fg("muted", ` (${lineCount} lines)`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			return renderCollapsedErrorOrSummary(result, context.isError, theme, " → wrote");
		},
	});

	if (overrideReadEdit) {
		pi.registerTool({
			name: "edit",
			label: "edit",
			description:
				"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
			parameters: getBuiltInTools(process.cwd()).edit.parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args, theme) {
				const path = shortenPath(args.path || "");
				return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}`, 0, 0);
			},
			renderResult(result, { expanded }, theme, context) {
				if (expanded) return renderExpandedText(result, theme);
				return renderCollapsedErrorOrSummary(result, context.isError, theme, " → updated");
			},
		});
	}

	pi.registerTool({
		name: "find",
		label: "find",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: getBuiltInTools(process.cwd()).find.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${path}`)}`;
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} files` : "";
			return renderCollapsedErrorOrSummary(result, context.isError, theme, summary);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 200 matches.",
		parameters: getBuiltInTools(process.cwd()).grep.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("toolOutput", ` in ${path}`)}`;
			if (args.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} matches` : "";
			return renderCollapsedErrorOrSummary(result, context.isError, theme, summary);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "ls",
		description:
			"List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
		parameters: getBuiltInTools(process.cwd()).ls.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			if (expanded) return renderExpandedText(result, theme);
			const count = countNonEmptyLines(getTextContent(result) || "");
			const summary = count > 0 ? ` → ${count} entries` : "";
			return renderCollapsedErrorOrSummary(result, context.isError, theme, summary);
		},
	});
}
