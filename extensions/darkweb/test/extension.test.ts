import assert from "node:assert/strict";
import test from "node:test";
import darkwebExtension, { TOOL_REGISTRY } from "../index.ts";

test("registers exactly seven dark-web tools without prompt injection and starts them inactive", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, Record<string, unknown>>();
  let active = ["read", "bash", "another_extension_tool"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
      active.push(tool.name as string);
    },
    on(name: string, callback: (...args: unknown[]) => unknown) {
      events.set(name, callback);
    },
    registerCommand(name: string, command: Record<string, unknown>) {
      commands.set(name, command);
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };

  darkwebExtension(pi as never);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "onion_search",
    "onion_lookup",
    "securedrop_search",
    "ransomware_search",
    "onion_fetch",
    "tor_status",
    "breach_search",
  ]);
  for (const tool of tools) {
    assert.equal("promptSnippet" in tool, false);
    assert.equal("promptGuidelines" in tool, false);
  }

  events.get("session_start")?.();
  assert.deepEqual(active, ["read", "bash", "another_extension_tool"]);

  const notices: string[] = [];
  const command = commands.get("darkweb")!;
  const handler = command.handler as (args: string, ctx: unknown) => Promise<void>;
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };
  await handler("on onion_lookup", ctx);
  assert.deepEqual(active, ["read", "bash", "another_extension_tool", "onion_lookup"]);
  await handler("off onion_lookup", ctx);
  assert.deepEqual(active, ["read", "bash", "another_extension_tool"]);
  await handler("on all", ctx);
  assert.equal(TOOL_REGISTRY.every((tool) => active.includes(tool.name)), true);
  assert.ok(notices.length >= 3);
});
