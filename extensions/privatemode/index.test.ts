import assert from "node:assert/strict";
import test from "node:test";

import {
  FALLBACK_MODEL_IDS,
  configsFromModelEntries,
  type PrivateModeModelEntry,
} from "./index.ts";

const CURRENT_CATALOG: PrivateModeModelEntry[] = [
  { id: "deepseek-ocr-2", tasks: ["generate", "vision"] },
  { id: "glm-5.3", tasks: ["generate", "tool_calling"] },
  { id: "glm-5.2", tasks: ["generate", "tool_calling"] },
  { id: "glm-latest", tasks: ["generate", "tool_calling"] },
  { id: "glm-5.3-flash", tasks: ["generate", "tool_calling", "vision"] },
  { id: "glm-flash-latest", tasks: ["generate", "tool_calling", "vision"] },
  { id: "openai/gpt-oss-120b", tasks: ["generate", "tool_calling"] },
  { id: "gpt-oss-120b", tasks: ["generate", "tool_calling"] },
  { id: "gpt-oss-latest", tasks: ["generate", "tool_calling"] },
  { id: "openai/whisper-large-v3", tasks: ["transcribe"] },
  { id: "whisper-large-v3", tasks: ["transcribe"] },
  { id: "qwen3-embedding-4b", tasks: ["embed"] },
  { id: "voxtral-mini-3b", tasks: ["transcribe"] },
];

test("fallback catalog contains only current canonical chat models", () => {
  assert.deepEqual(FALLBACK_MODEL_IDS, ["glm-5.3", "glm-5.3-flash", "gpt-oss-120b"]);
  assert.equal(FALLBACK_MODEL_IDS.some((id) => id.startsWith("kimi-")), false);
});

test("live catalog uses tasks to expose only tool-capable chat models", () => {
  const models = configsFromModelEntries(CURRENT_CATALOG);
  assert.deepEqual(
    models.map((model) => model.id),
    [
      "glm-5.3",
      "glm-5.2",
      "glm-latest",
      "glm-5.3-flash",
      "glm-flash-latest",
      "openai/gpt-oss-120b",
      "gpt-oss-120b",
      "gpt-oss-latest",
    ]
  );
});

test("current model metadata matches documented capabilities", () => {
  const models = configsFromModelEntries(CURRENT_CATALOG);
  const byId = new Map(models.map((model) => [model.id, model]));

  const glm = byId.get("glm-5.3");
  assert.ok(glm);
  assert.equal(glm.reasoning, true);
  assert.deepEqual(glm.input, ["text"]);
  assert.equal(glm.contextWindow, 1_000_000);
  assert.equal(glm.maxTokens, 131_072);
  assert.equal(glm.thinkingLevelMap?.off, "none");
  assert.equal(glm.thinkingLevelMap?.max, "max");

  const flash = byId.get("glm-5.3-flash");
  assert.ok(flash);
  assert.deepEqual(flash.input, ["text", "image"]);
  assert.equal(flash.contextWindow, 1_000_000);

  const gptOss = byId.get("gpt-oss-120b");
  assert.ok(gptOss);
  assert.deepEqual(gptOss.input, ["text"]);
  assert.equal(gptOss.contextWindow, 131_072);
  assert.equal(gptOss.maxTokens, 32_768);
  assert.equal(gptOss.thinkingLevelMap?.medium, "medium");
});

test("stored removed and specialized model IDs do not return offline", () => {
  const models = configsFromModelEntries([
    { id: "kimi-k2.6" },
    { id: "deepseek-ocr-2" },
    { id: "whisper-large-v3" },
    { id: "glm-5.3" },
  ]);
  assert.deepEqual(models.map((model) => model.id), ["glm-5.3"]);
});

test("future tool-capable vision entries receive safe generic metadata", () => {
  const [model] = configsFromModelEntries([
    { id: "future-chat-vision", tasks: ["generate", "tool_calling", "vision"] },
  ]);
  assert.ok(model);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 16_384);
});
