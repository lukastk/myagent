/**
 * Session Model Extension
 *
 * Adds commands and shortcuts for session-only model management:
 *
 *   `/smodel`              - show a selector to pick a model
 *   `/smodel claude-sonnet` - fuzzy-match and switch directly
 *   `/smodel-scope`         - configure which models the scope feature uses
 *
 * Keyboard shortcuts:
 *   Ctrl+Alt+L       - open the /smodel selector (mirrors Ctrl+L for /model)
 *   Ctrl+Alt+P       - cycle to next scoped model (or all available if no scope set)
 *   Shift+Ctrl+Alt+P - cycle to previous scoped model
 *
 * The selector understands a "Scope: all | scoped" toggle (Tab) when a
 * scope is configured via /smodel-scope, just like pi's built-in /model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  fuzzyFilter,
} from "@mariozechner/pi-tui";

interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

const SETTINGS_KEY = "sessionModelScopeIds";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Extension-scoped model IDs for Ctrl+Alt+P cycling and the selector scope toggle.
 *  null = no scope configured (selector behaves like a plain list). */
let sessionScopedIds: Set<string> | null = null;

function loadScope(): void {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    const ids: unknown = settings[SETTINGS_KEY];
    if (Array.isArray(ids) && ids.length > 0) {
      sessionScopedIds = new Set(ids.map(String));
    } else {
      sessionScopedIds = null;
    }
  } catch {
    sessionScopedIds = null;
  }
}

function saveScope(ids: Set<string> | null): void {
  try {
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {
      // file doesn't exist or is invalid, start fresh
    }
    if (ids === null || ids.size === 0) {
      delete settings[SETTINGS_KEY];
    } else {
      settings[SETTINGS_KEY] = [...ids].sort();
    }
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch (err) {
    console.error("[session-model] Failed to save scope:", err);
  }
}

/**
 * Collect available models across all providers.
 * Uses getAvailable() which only returns models with valid API keys.
 */
async function getAvailableModels(ctx: ExtensionContext): Promise<ModelChoice[]> {
  const available = await ctx.modelRegistry.getAvailable();
  return available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name || m.id,
  }));
}

/**
 * Open the /smodel selector. Shared between the `/smodel` command and the
 * Ctrl+Alt+L shortcut.
 */
async function runSmodelSelector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const models = await getAvailableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify("No models available", "error");
    return;
  }

  const query = args.trim();
  if (query) {
    const matches = fuzzyFilter(models, query, (m) => `${m.provider} ${m.name} ${m.id}`);

    if (matches.length === 0) {
      ctx.ui.notify(`No model matching "${query}"`, "error");
      return;
    }

    if (matches.length === 1) {
      const choice = matches[0];
      const model = ctx.modelRegistry.find(choice.provider, choice.id);
      if (model) {
        const success = await pi.setModel(model);
        if (success) {
          ctx.ui.notify(
            `Model set to ${choice.provider}/${choice.id} (session only)`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `No API key for ${choice.provider}/${choice.id}`,
            "error",
          );
        }
      }
      return;
    }

    // Multiple matches: open the full selector with the query pre-filled so
    // the user can still toggle scope to widen/narrow the list.
    await showSelector(ctx, pi, models, { initialSearch: query });
    return;
  }

  // No args: show full selector with scope toggle (if configured).
  await showSelector(ctx, pi, models);
}

export default function (pi: ExtensionAPI) {
  loadScope();

  pi.registerCommand("smodel", {
    description:
      "Switch model for current session only (does not modify settings.json)",
    handler: async (args, ctx) => {
      await runSmodelSelector(pi, ctx, args ?? "");
    },
  });

  // Keyboard shortcut: Ctrl+Alt+L — open the /smodel selector
  // (mirrors pi's built-in Ctrl+L which opens /model).
  pi.registerShortcut("ctrl+alt+l", {
    description: "Open /smodel selector (session only)",
    handler: async (ctx) => {
      await runSmodelSelector(pi, ctx, "");
    },
  });

  // Keyboard shortcut: Ctrl+Alt+P — cycle to next model (session only)
  pi.registerShortcut("ctrl+alt+p", {
    description: "Cycle to next model (session only)",
    handler: async (ctx) => cycleToModel(pi, ctx, "forward"),
  });

  // Keyboard shortcut: Shift+Ctrl+Alt+P — cycle to previous model (session only)
  pi.registerShortcut("shift+ctrl+alt+p", {
    description: "Cycle to previous model (session only)",
    handler: async (ctx) => cycleToModel(pi, ctx, "backward"),
  });

  // Command: /smodel-scope — configure which models the scope toggle uses
  pi.registerCommand("smodel-scope", {
    description:
      "Configure which models Ctrl+Alt+P / scoped selector cycle through",
    handler: async (_args, ctx) => {
      const models = await getAvailableModels(ctx);
      if (models.length === 0) {
        ctx.ui.notify("No models available", "error");
        return;
      }

      const currentIds = sessionScopedIds
        ? new Set(sessionScopedIds)
        : new Set(models.map((m) => `${m.provider}/${m.id}`));

      const result = await showScopeSelector(ctx, models, currentIds);
      if (result !== null) {
        sessionScopedIds = result.size === models.length ? null : result;
        saveScope(sessionScopedIds);
        const count = result.size;
        const total = models.length;
        if (sessionScopedIds === null) {
          ctx.ui.notify(
            `Ctrl+Alt+P scope: all ${total} models`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Ctrl+Alt+P scope: ${count}/${total} models`,
            "info",
          );
        }
      }
    },
  });
}

async function showSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  allModels: ModelChoice[],
  options: { initialSearch?: string } = {},
): Promise<void> {
  const allItems: SelectItem[] = allModels.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: m.name,
    description: `${m.provider}/${m.id}`,
  }));

  const scopedKeys = sessionScopedIds;
  const hasScope = scopedKeys !== null && scopedKeys.size > 0;
  // Models that survive the scope filter — used to detect whether the
  // "scoped" view would be empty (in which case we don't offer the toggle).
  const scopedAvailable = hasScope
    ? allItems.filter((it) => scopedKeys!.has(it.value))
    : allItems;
  const offerScope = hasScope && scopedAvailable.length > 0;

  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      let searchQuery = options.initialSearch?.trim() ?? "";
      // Default to "scoped" if a non-empty scope is configured, matching pi /model.
      let scope: "all" | "scoped" = offerScope ? "scoped" : "all";

      function scopedItems(): SelectItem[] {
        if (scope === "scoped" && offerScope) {
          return allItems.filter((it) => scopedKeys!.has(it.value));
        }
        return allItems;
      }

      function filteredItems(): SelectItem[] {
        const base = scopedItems();
        if (!searchQuery) return base;
        return fuzzyFilter(base, searchQuery, (item) => `${item.label} ${item.description ?? ""}`);
      }

      const container = new Container();

      // Top border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str)),
      );

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Switch Model (session only)")),
        ),
      );

      // Scope line (only when a scope is configured)
      const scopeText = offerScope ? new Text("", 0, 0) : undefined;
      const scopeHintText = offerScope ? new Text("", 0, 0) : undefined;
      if (scopeText && scopeHintText) {
        container.addChild(scopeText);
        container.addChild(scopeHintText);
      }

      // Search display (Text that updates as user types)
      const searchText = new Text(
        theme.fg("muted", "Type to search..."),
        0,
        0,
      );
      container.addChild(searchText);

      // Build initial SelectList
      let selectList = buildSelectList(filteredItems(), theme, done);
      container.addChild(selectList);

      function buildSelectList(
        items: SelectItem[],
        theme: any,
        done: (value: string | null) => void,
      ): SelectList {
        const sl = new SelectList(items, Math.min(items.length, 15), {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        });
        sl.onSelect = (item) => done(item.value);
        sl.onCancel = () => done(null);
        return sl;
      }

      function rebuildSelectList() {
        const idx = container.children.indexOf(selectList);
        if (idx !== -1) {
          container.children[idx] = buildSelectList(
            filteredItems(),
            theme,
            done,
          );
          selectList = container.children[idx] as SelectList;
        }
        container.invalidate();
      }

      // Footer
      const footerHint = offerScope
        ? "↑↓ navigate · enter select · tab scope · esc cancel · type to search"
        : "↑↓ navigate · enter select · esc cancel · type to search";
      container.addChild(
        new Text(theme.fg("dim", footerHint)),
      );

      // Bottom border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str)),
      );

      function updateScopeDisplay() {
        if (!scopeText || !scopeHintText) return;
        const allLabel =
          scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
        const scopedLabel =
          scope === "scoped"
            ? theme.fg("accent", "scoped")
            : theme.fg("muted", "scoped");
        scopeText.setText(
          `${theme.fg("muted", "Scope: ")}${allLabel}${theme.fg("muted", " | ")}${scopedLabel}`,
        );
        scopeText.invalidate();
        scopeHintText.setText(
          `${theme.fg("accent", "tab")} ${theme.fg("muted", "scope (all/scoped)")}`,
        );
        scopeHintText.invalidate();
      }

      function updateSearchDisplay() {
        if (searchQuery) {
          searchText.setText(theme.fg("accent", `Search: ${searchQuery}`));
        } else {
          searchText.setText(theme.fg("muted", "Type to search..."));
        }
        searchText.invalidate();
      }

      updateScopeDisplay();
      updateSearchDisplay();

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          // Tab — toggle scope (only when a scope is configured)
          if (offerScope && matchesKey(data, Key.tab)) {
            scope = scope === "all" ? "scoped" : "all";
            updateScopeDisplay();
            rebuildSelectList();
            tui.requestRender();
            return;
          }

          // Escape with active search: clear search first, second esc cancels
          if (data === "\x1b" && searchQuery) {
            searchQuery = "";
            updateSearchDisplay();
            rebuildSelectList();
            tui.requestRender();
            return;
          }

          // Backspace
          if (data === "\x7f" || data === "\b") {
            if (searchQuery.length > 0) {
              searchQuery = searchQuery.slice(0, -1);
              updateSearchDisplay();
              rebuildSelectList();
              tui.requestRender();
            }
            return;
          }

          // Printable character - add to search
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            searchQuery += data;
            updateSearchDisplay();
            rebuildSelectList();
            tui.requestRender();
            return;
          }

          // Pass everything else (arrows, enter, etc.) to SelectList
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  if (!result) return;

  const [provider, ...idParts] = result.split("/");
  const id = idParts.join("/");
  const model = ctx.modelRegistry.find(provider, id);
  if (model) {
    const success = await pi.setModel(model);
    if (success) {
      ctx.ui.notify(
        `Model set to ${provider}/${id} (session only)`,
        "info",
      );
    } else {
      ctx.ui.notify(`No API key for ${provider}/${id}`, "error");
    }
  }
}

/**
 * Multi-select TUI for configuring which models the scope toggle / Ctrl+Alt+P uses.
 */
async function showScopeSelector(
  ctx: ExtensionCommandContext,
  models: ModelChoice[],
  currentIds: Set<string>,
): Promise<Set<string> | null> {
  const allItems = models.map((m) => ({
    key: `${m.provider}/${m.id}`,
    label: m.name,
    provider: m.provider,
  }));

  const initialEnabled = new Set(currentIds);

  const result = await ctx.ui.custom<Set<string> | null>(
    (tui, theme, _kb, done) => {
      const maxVisible = 12;
      let enabled = new Set(initialEnabled);
      let searchQuery = "";
      let selectedIndex = 0;

      function filteredItems() {
        if (!searchQuery) return allItems;
        return fuzzyFilter(allItems, searchQuery, (item) => `${item.label} ${item.key}`);
      }

      const container = new Container();

      // Top border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str)),
      );

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Configure Ctrl+Alt+P Scope")),
        ),
      );

      // Search display
      const searchText = new Text(
        theme.fg("muted", "Type to search..."),
        0,
        0,
      );
      container.addChild(searchText);

      // List container - rebuilt on every change
      let listContainer = new Container();
      container.addChild(listContainer);

      // Footer
      const footerText = new Text("", 0, 0);
      container.addChild(footerText);

      // Bottom border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str)),
      );

      function updateSearchDisplay() {
        if (searchQuery) {
          searchText.setText(
            theme.fg("accent", `Search: ${searchQuery}`),
          );
        } else {
          searchText.setText(theme.fg("muted", "Type to search..."));
        }
        searchText.invalidate();
      }

      function updateFooter() {
        const items = filteredItems();
        const enabledCount = [...items].filter((i) => enabled.has(i.key)).length;
        const totalFiltered = items.length;
        const parts = [
          theme.fg("dim", "↑↓ nav"),
          theme.fg("dim", "· enter toggle"),
          theme.fg("dim", "· ctrl+a all"),
          theme.fg("dim", "· ctrl+x clear"),
          theme.fg("dim", "· esc apply"),
          theme.fg("accent", `· ${enabledCount}/${totalFiltered} selected`),
        ];
        footerText.setText(`  ${parts.join(" ")}`);
        footerText.invalidate();
      }

      function renderList() {
        const items = filteredItems();
        selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));

        listContainer.clear();
        if (items.length === 0) {
          listContainer.addChild(
            new Text(theme.fg("warning", "  No matching models"), 0, 0),
          );
          return;
        }

        const start = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
        const end = Math.min(items.length, start + maxVisible);

        for (let i = start; i < end; i++) {
          const item = items[i];
          const isSelected = i === selectedIndex;
          const isEnabled = enabled.has(item.key);
          const prefix = isSelected
            ? theme.fg("accent", "→ ")
            : "  ";
          const name = isSelected
            ? theme.fg("accent", item.label)
            : item.label;
          const provider = theme.fg("muted", ` [${item.provider}]`);
          const check = isEnabled
            ? theme.fg("success", " ✓")
            : theme.fg("dim", " ✗");
          listContainer.addChild(
            new Text(`${prefix}${name}${provider}${check}`, 0, 0),
          );
        }

        if (start > 0 || end < items.length) {
          listContainer.addChild(
            new Text(
              theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`),
              0,
              0,
            ),
          );
        }
      }

      function refresh() {
        updateSearchDisplay();
        renderList();
        updateFooter();
        container.invalidate();
      }

      refresh();

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          // Escape — apply changes and close
          if (matchesKey(data, Key.escape)) {
            done(enabled);
            return;
          }

          // Ctrl+C — cancel (revert to original)
          if (matchesKey(data, Key.ctrl("c"))) {
            if (searchQuery) {
              searchQuery = "";
              refresh();
            } else {
              done(null);
            }
            return;
          }

          // Ctrl+A — enable all
          if (matchesKey(data, Key.ctrl("a"))) {
            const items = filteredItems();
            for (const item of items) {
              enabled.add(item.key);
            }
            refresh();
            return;
          }

          // Ctrl+X — clear all
          if (matchesKey(data, Key.ctrl("x"))) {
            const items = filteredItems();
            for (const item of items) {
              enabled.delete(item.key);
            }
            refresh();
            return;
          }

          // Backspace / Delete — clear search
          if (data === "\x7f" || data === "\b") {
            if (searchQuery.length > 0) {
              searchQuery = searchQuery.slice(0, -1);
              selectedIndex = 0;
              refresh();
            }
            return;
          }

          // Printable character — add to search
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            searchQuery += data;
            selectedIndex = 0;
            refresh();
            return;
          }

          // Up arrow
          if (data === "\x1b[A") {
            const items = filteredItems();
            if (items.length === 0) return;
            selectedIndex =
              selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
            refresh();
            return;
          }

          // Down arrow
          if (data === "\x1b[B") {
            const items = filteredItems();
            if (items.length === 0) return;
            selectedIndex =
              selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
            refresh();
            return;
          }

          // Enter — toggle
          if (data === "\r") {
            const items = filteredItems();
            if (items.length === 0) return;
            const item = items[selectedIndex];
            if (enabled.has(item.key)) {
              enabled.delete(item.key);
            } else {
              enabled.add(item.key);
            }
            refresh();
            return;
          }
        },
      };
    },
  );

  return result;
}

/**
 * Cycle to the next or previous model in the Ctrl+Alt+P scope.
 * Falls back to all available models if no scope has been configured.
 */
async function cycleToModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  direction: "forward" | "backward",
): Promise<void> {
  let allModels = ctx.modelRegistry.getAvailable();
  if (allModels.length === 0) return;

  // Filter by extension-scoped model IDs if configured
  const scopeSet = sessionScopedIds;
  if (scopeSet !== null) {
    allModels = allModels.filter((m) =>
      scopeSet.has(`${m.provider}/${m.id}`),
    );
    if (allModels.length === 0) {
      ctx.ui.notify("No models in Ctrl+Alt+P scope", "warning");
      return;
    }
  }

  if (allModels.length <= 1) {
    const label = scopeSet !== null ? "scope" : "available";
    ctx.ui.notify(`Only one model in ${label}`, "info");
    return;
  }

  const currentModel = ctx.model;
  let currentIndex = -1;
  if (currentModel) {
    currentIndex = allModels.findIndex(
      (m) => m.provider === currentModel.provider && m.id === currentModel.id,
    );
  }
  if (currentIndex === -1) currentIndex = 0;

  const len = allModels.length;
  const nextIndex =
    direction === "forward"
      ? (currentIndex + 1) % len
      : (currentIndex - 1 + len) % len;

  const nextModel = allModels[nextIndex];
  const success = await pi.setModel(nextModel);
  if (success) {
    const thinkingStr =
      nextModel.reasoning ? ` (thinking: ${nextModel.reasoning})` : "";
    const displayName = nextModel.name || nextModel.id;
    ctx.ui.notify(
      `Switched to ${nextModel.provider}/${displayName}${thinkingStr} (session only)`,
      "info",
    );
  }
}
