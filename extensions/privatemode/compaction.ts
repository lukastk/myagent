import type { Usage } from "@earendil-works/pi-ai";
import type {
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

import { estimatePrivateModePromptTokens } from "./rate-limit.ts";

/**
 * PrivateMode permits 200k uncached prompt tokens per minute. Keep each
 * standalone summary request substantially below that hard limit so payload
 * serialization differences and provider-side tokenization have headroom.
 */
export const PRIVATE_MODE_COMPACTION_PROMPT_TARGET = 150_000;
export const PRIVATE_MODE_COMPACTION_MAX_OUTPUT_TOKENS = 8_192;

export const PRIVATE_MODE_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

const UPDATE_TURN_PREFIX_PROMPT = `The messages above are the next chronological chunk of the same earlier turn. Update the checkpoint in <previous-turn-context> with the new information.

PRESERVE information already present, ADD newly observed requests and progress, and keep this EXACT format:

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present in the previous checkpoint and the new messages. Do not infer or recreate later messages.`;

const TOOL_RESULT_MAX_CHARS = 2_000;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n`;
const BRANCH_SUMMARY_SUFFIX = "</summary>";
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(
          block &&
            typeof block === "object" &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
        )
    )
    .map((block) => block.text)
    .join("");
}

function bashExecutionText(message: Record<string, unknown>): string {
  let text = `Ran \`${String(message.command ?? "")}\`\n`;
  text += message.output ? `\`\`\`\n${String(message.output)}\n\`\`\`` : "(no output)";
  if (message.cancelled) text += "\n\n(command cancelled)";
  else if (
    message.exitCode !== null &&
    message.exitCode !== undefined &&
    message.exitCode !== 0
  ) {
    text += `\n\nCommand exited with code ${String(message.exitCode)}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${String(message.fullOutputPath)}]`;
  }
  return text;
}

/** Mirrors Pi's compaction serialization without importing runtime code in tests. */
export function serializePrivateModeCompactionMessages(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object" || !("role" in value)) continue;
    const message = value as Record<string, unknown>;
    const role = message.role;
    if (role === "bashExecution") {
      if (!message.excludeFromContext) parts.push(`[User]: ${bashExecutionText(message)}`);
      continue;
    }
    if (role === "custom") {
      const text = messageContentText(message.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }
    if (role === "branchSummary" || role === "compactionSummary") {
      const prefix =
        role === "branchSummary" ? BRANCH_SUMMARY_PREFIX : COMPACTION_SUMMARY_PREFIX;
      const suffix =
        role === "branchSummary" ? BRANCH_SUMMARY_SUFFIX : COMPACTION_SUMMARY_SUFFIX;
      parts.push(`[User]: ${prefix}${String(message.summary ?? "")}${suffix}`);
      continue;
    }
    if (role === "user") {
      const text = messageContentText(message.content);
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }
    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = messageContentText(content);
      if (text) parts.push(`[Assistant]: ${text}`);
      const toolCalls: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "toolCall" &&
          "name" in block
        ) {
          const args =
            "arguments" in block && block.arguments && typeof block.arguments === "object"
              ? block.arguments as Record<string, unknown>
              : {};
          const argsText = Object.entries(args)
            .map(([key, entry]) => `${key}=${JSON.stringify(entry)}`)
            .join(", ");
          toolCalls.push(`${String(block.name)}(${argsText})`);
        }
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
      continue;
    }
    if (role === "toolResult") {
      const text = messageContentText(message.content);
      if (text) {
        const truncated =
          text.length <= TOOL_RESULT_MAX_CHARS
            ? text
            : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${
                text.length - TOOL_RESULT_MAX_CHARS
              } more characters truncated]`;
        parts.push(`[Tool result]: ${truncated}`);
      }
    }
  }
  return parts.join("\n\n");
}


export interface PrivateModeSummaryCompletion {
  text: string;
  usage: Usage;
}

export interface PrivateModeCompactionOptions {
  complete: (
    prompt: string,
    estimatedPromptTokens: number,
    requestNumber: number,
    signal: AbortSignal
  ) => Promise<PrivateModeSummaryCompletion>;
  onRequest?: (requestNumber: number, estimatedPromptTokens: number) => void;
}

interface ProgressiveSummaryResult {
  text: string;
  usage?: Usage;
  requests: number;
  chunked: boolean;
}

type PromptBuilder = (conversationText: string, previousSummary?: string) => string;

function abortError(): Error {
  const error = new Error("PrivateMode compaction cancelled");
  error.name = "AbortError";
  return error;
}

export function shouldUsePrivateModeCompaction(provider: string | undefined): boolean {
  return provider === "privatemode";
}

export function estimatePrivateModeSummaryPromptTokens(prompt: string): number {
  return estimatePrivateModePromptTokens({
    model: "privatemode-compaction",
    messages: [
      { role: "system", content: PRIVATE_MODE_SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: PRIVATE_MODE_COMPACTION_MAX_OUTPUT_TOKENS,
    stream: true,
  });
}

function withCustomInstructions(prompt: string, customInstructions?: string): string {
  return customInstructions
    ? `${prompt}\n\nAdditional focus: ${customInstructions}`
    : prompt;
}

export function buildHistorySummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string
): string {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  return withCustomInstructions(prompt, customInstructions);
}

export function buildTurnPrefixSummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string
): string {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `<previous-turn-context>\n${previousSummary}\n</previous-turn-context>\n\n`;
  }
  prompt += previousSummary ? UPDATE_TURN_PREFIX_PROMPT : TURN_PREFIX_SUMMARIZATION_PROMPT;
  return withCustomInstructions(prompt, customInstructions);
}

function safeBoundary(text: string, maximumEnd: number): number {
  if (maximumEnd >= text.length) return text.length;
  const minimumBoundary = Math.floor(maximumEnd * 0.6);
  for (const separator of ["\n\n", "\n", " "]) {
    const boundary = text.lastIndexOf(
      separator,
      Math.max(0, maximumEnd - separator.length)
    );
    if (boundary >= minimumBoundary) return boundary + separator.length;
  }
  let end = maximumEnd;
  const lastCodeUnit = text.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return Math.max(1, end);
}

/** Select the largest leading text chunk whose complete summary payload fits. */
export function takePrivateModePromptChunk(
  remainingText: string,
  previousSummary: string | undefined,
  buildPrompt: PromptBuilder,
  targetTokens = PRIVATE_MODE_COMPACTION_PROMPT_TARGET
): { chunk: string; prompt: string; estimatedPromptTokens: number } {
  if (!remainingText) {
    throw new Error("Cannot take a PrivateMode compaction chunk from empty text");
  }
  const emptyPromptTokens = estimatePrivateModeSummaryPromptTokens(
    buildPrompt("", previousSummary)
  );
  if (emptyPromptTokens >= targetTokens) {
    throw new Error(
      `PrivateMode compaction summary state alone is estimated at ${emptyPromptTokens.toLocaleString()} prompt tokens, ` +
        `leaving no room below the ${targetTokens.toLocaleString()}-token chunk target.`
    );
  }

  let low = 1;
  let high = remainingText.length;
  let best = 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const prompt = buildPrompt(remainingText.slice(0, middle), previousSummary);
    const estimate = estimatePrivateModeSummaryPromptTokens(prompt);
    if (estimate <= targetTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best < 1) {
    throw new Error("PrivateMode compaction could not fit even one input character in a summary request");
  }

  const end = safeBoundary(remainingText, best);
  const chunk = remainingText.slice(0, end);
  const prompt = buildPrompt(chunk, previousSummary);
  const estimatedPromptTokens = estimatePrivateModeSummaryPromptTokens(prompt);
  if (estimatedPromptTokens > targetTokens) {
    throw new Error(
      `PrivateMode compaction chunk estimate ${estimatedPromptTokens.toLocaleString()} exceeded ` +
        `${targetTokens.toLocaleString()} tokens after boundary selection`
    );
  }
  return { chunk, prompt, estimatedPromptTokens };
}

function combineUsage(first: Usage | undefined, second: Usage): Usage {
  if (!first) return second;
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
      totalFromProvider:
        first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
    },
  };
}

export async function summarizePrivateModeText(
  text: string,
  previousSummary: string | undefined,
  buildPrompt: PromptBuilder,
  options: PrivateModeCompactionOptions,
  signal: AbortSignal
): Promise<ProgressiveSummaryResult> {
  if (!text) {
    if (!previousSummary) throw new Error("PrivateMode compaction received no text to summarize");
    return { text: previousSummary, requests: 0, chunked: false };
  }

  let remaining = text;
  let summary = previousSummary;
  let usage: Usage | undefined;
  let requests = 0;
  while (remaining.length > 0) {
    if (signal.aborted) throw abortError();
    const selected = takePrivateModePromptChunk(remaining, summary, buildPrompt);
    requests += 1;
    options.onRequest?.(requests, selected.estimatedPromptTokens);
    const result = await options.complete(
      selected.prompt,
      selected.estimatedPromptTokens,
      requests,
      signal
    );
    if (!result.text.trim()) {
      throw new Error(`PrivateMode compaction request ${requests} returned an empty summary`);
    }
    summary = result.text.trim();
    usage = combineUsage(usage, result.usage);
    remaining = remaining.slice(selected.chunk.length);
  }

  return { text: summary!, usage, requests, chunked: requests > 1 };
}

function fileListFromSummary(summary: string | undefined, tag: string): string[] {
  if (!summary) return [];
  const match = summary.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "g"));
  if (!match) return [];
  return match.flatMap((section) => {
    const firstNewline = section.indexOf("\n");
    const lastNewline = section.lastIndexOf("\n");
    return section
      .slice(firstNewline + 1, lastNewline)
      .split("\n")
      .filter(Boolean);
  });
}

function computeFileLists(
  fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"],
  previousSummary?: string
): { readFiles: string[]; modifiedFiles: string[] } {
  // Pi intentionally treats hook details as extension-specific, so its next
  // preparation does not carry our prior file lists forward. Recover the XML
  // lists appended to the previous PrivateMode summary before adding new ops.
  const modified = new Set([
    ...fileListFromSummary(previousSummary, "modified-files"),
    ...fileOps.edited,
    ...fileOps.written,
  ]);
  const read = new Set([
    ...fileListFromSummary(previousSummary, "read-files"),
    ...fileOps.read,
  ]);
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

export async function buildPrivateModeCompaction(
  event: SessionBeforeCompactEvent,
  options: PrivateModeCompactionOptions
): Promise<SessionBeforeCompactResult> {
  const { preparation, customInstructions, signal } = event;
  const {
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    previousSummary,
    firstKeptEntryId,
    tokensBefore,
    fileOps,
  } = preparation;

  const historyText = serializePrivateModeCompactionMessages(messagesToSummarize);
  const history = historyText
    ? await summarizePrivateModeText(
        historyText,
        previousSummary,
        (chunk, prior) => buildHistorySummaryPrompt(chunk, prior, customInstructions),
        options,
        signal
      )
    : {
        text: previousSummary ?? "No prior history.",
        usage: undefined,
        requests: 0,
        chunked: false,
      };

  let summary = history.text;
  let usage = history.usage;
  let requests = history.requests;
  let chunked = history.chunked;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const turnPrefixText = serializePrivateModeCompactionMessages(turnPrefixMessages);
    const turnPrefix = await summarizePrivateModeText(
      turnPrefixText,
      undefined,
      (chunk, prior) => buildTurnPrefixSummaryPrompt(chunk, prior, customInstructions),
      options,
      signal
    );
    summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`;
    if (turnPrefix.usage) usage = combineUsage(usage, turnPrefix.usage);
    requests += turnPrefix.requests;
    chunked ||= turnPrefix.chunked;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps, previousSummary);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      usage,
      details: {
        readFiles,
        modifiedFiles,
        privateModeCompaction: true,
        privateModeSummaryRequests: requests,
        privateModeChunked: chunked,
      },
    },
  };
}
