import assert from "node:assert/strict";
import test from "node:test";

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import {
  PRIVATE_MODE_COMPACTION_PROMPT_TARGET,
  buildHistorySummaryPrompt,
  buildPrivateModeCompaction,
  estimatePrivateModeSummaryPromptTokens,
  shouldUsePrivateModeCompaction,
  summarizePrivateModeText,
  takePrivateModePromptChunk,
} from "./compaction.ts";

function usage(input = 10, output = 5): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("PrivateMode compaction is selected only for the PrivateMode provider", () => {
  assert.equal(shouldUsePrivateModeCompaction("privatemode"), true);
  assert.equal(shouldUsePrivateModeCompaction("openai-codex"), false);
  assert.equal(shouldUsePrivateModeCompaction(undefined), false);
});

test("chunk selection keeps an oversized prompt below the uncached target", () => {
  const text = "x".repeat(900_000);
  const selected = takePrivateModePromptChunk(
    text,
    undefined,
    (chunk, previous) => buildHistorySummaryPrompt(chunk, previous)
  );
  assert.ok(selected.chunk.length > 0);
  assert.ok(selected.chunk.length < text.length);
  assert.ok(selected.estimatedPromptTokens <= PRIVATE_MODE_COMPACTION_PROMPT_TARGET);
  assert.equal(
    selected.estimatedPromptTokens,
    estimatePrivateModeSummaryPromptTokens(selected.prompt)
  );
});

test("progressive summaries preserve order and feed each result into the next request", async () => {
  const prompts: string[] = [];
  const text = `${"a".repeat(700_000)}\n\n${"b".repeat(700_000)}`;
  const result = await summarizePrivateModeText(
    text,
    undefined,
    (chunk, previous) => buildHistorySummaryPrompt(chunk, previous),
    {
      complete: async (prompt, estimatedPromptTokens) => {
        prompts.push(prompt);
        assert.ok(estimatedPromptTokens <= PRIVATE_MODE_COMPACTION_PROMPT_TARGET);
        return { text: `summary-${prompts.length}`, usage: usage() };
      },
    },
    new AbortController().signal
  );

  assert.ok(prompts.length >= 2);
  assert.match(prompts[1], /<previous-summary>\nsummary-1\n<\/previous-summary>/);
  assert.equal(result.text, `summary-${prompts.length}`);
  assert.equal(result.requests, prompts.length);
  assert.equal(result.chunked, true);
  assert.equal(result.usage?.input, prompts.length * 10);
});

test("progressive compaction stops before the next chunk when cancelled", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    summarizePrivateModeText(
      "z".repeat(1_400_000),
      undefined,
      (chunk, previous) => buildHistorySummaryPrompt(chunk, previous),
      {
        complete: async () => {
          calls += 1;
          controller.abort();
          return { text: "partial checkpoint", usage: usage() };
        },
      },
      controller.signal
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(calls, 1);
});

test("compaction returns Pi's normal result shape with split-turn and file metadata", async () => {
  const event = {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [
        {
          role: "user",
          content: [{ type: "text", text: "Implement the feature." }],
          timestamp: 1,
        },
      ],
      turnPrefixMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I started the implementation." }],
          api: "openai-completions",
          provider: "privatemode",
          model: "glm-5.3",
          usage: usage(),
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      isSplitTurn: true,
      tokensBefore: 310_294,
      previousSummary:
        "## Goal\nExisting goal\n\n<read-files>\nold-read.ts\n</read-files>\n\n<modified-files>\nold-change.ts\n</modified-files>",
      fileOps: {
        read: new Set(["read-only.ts", "changed.ts"]),
        written: new Set(["created.ts"]),
        edited: new Set(["changed.ts"]),
      },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  } as SessionBeforeCompactEvent;

  let calls = 0;
  const result = await buildPrivateModeCompaction(event, {
    complete: async () => {
      calls += 1;
      return { text: `checkpoint-${calls}`, usage: usage(calls, 1) };
    },
  });

  assert.ok(result.compaction);
  assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
  assert.equal(result.compaction.tokensBefore, 310_294);
  assert.match(result.compaction.summary, /checkpoint-1/);
  assert.match(result.compaction.summary, /\*\*Turn Context \(split turn\):\*\*/);
  assert.match(result.compaction.summary, /checkpoint-2/);
  assert.match(
    result.compaction.summary,
    /<read-files>\nold-read\.ts\nread-only\.ts\n<\/read-files>/
  );
  assert.match(
    result.compaction.summary,
    /<modified-files>\nchanged\.ts\ncreated\.ts\nold-change\.ts\n<\/modified-files>/
  );
  assert.equal(result.compaction.usage?.input, 3);
  assert.deepEqual(result.compaction.details, {
    readFiles: ["old-read.ts", "read-only.ts"],
    modifiedFiles: ["changed.ts", "created.ts", "old-change.ts"],
    privateModeCompaction: true,
    privateModeSummaryRequests: 2,
    privateModeChunked: false,
  });
});
