/**
 * Session Model Extension
 *
 * Session-only model switching. It shares pi's *native* model scope
 * (`enabledModels`, exposed to extensions as `ctx.scopedModels`) rather than
 * maintaining its own list, so there is a single scoped-model set that drives
 * both pi's built-in Ctrl+P cycle and this extension's session-only cycle.
 *
 *   `/smodel`               - show a selector to pick a model (session only)
 *   `/smodel claude-sonnet`  - fuzzy-match and switch directly
 *
 * Keyboard shortcuts:
 *   Ctrl+Alt+L       - open the /smodel selector (mirrors Ctrl+L for /model)
 *   Ctrl+Alt+P       - cycle to next scoped model (session only)
 *   Shift+Ctrl+Alt+P - cycle to previous scoped model (session only)
 *
 * Scope comes from `ctx.scopedModels` (pi's resolved `enabledModels`). Edit
 * the scope with pi's built-in `/scoped-models` command — this extension only
 * *reads* it. When no scope is configured, the selector's toggle and the
 * cycle fall back to all available models.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  fuzzyFilter,
} from "@earendil-works/pi-tui";

interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

/**
 * The `provider/id` keys of the models scoped to this session, sourced from
 * pi's native scope (`ctx.scopedModels`, resolved from `enabledModels`).
 * Returns null when no scope is configured (all available models are usable),
 * so callers can fall back to the full list.
 */
function scopedKeys(ctx: ExtensionContext): Set<string> | null {
  const scoped = ctx.scopedModels;
  if (!scoped || scoped.length === 0) return null;
  return new Set(scoped.map((s) => `${s.model.provider}/${s.model.id}`));
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

  const scoped = scopedKeys(ctx);
  const hasScope = scoped !== null;
  // Models that survive the scope filter — used to detect whether the
  // "scoped" view would be empty (in which case we don't offer the toggle).
  const scopedAvailable = hasScope
    ? allItems.filter((it) => scoped!.has(it.value))
    : allItems;
  const offerScope = hasScope && scopedAvailable.length > 0;

  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      let searchQuery = options.initialSearch?.trim() ?? "";
      // Default to "scoped" if a non-empty scope is configured, matching pi /model.
      let scope: "all" | "scoped" = offerScope ? "scoped" : "all";

      function scopedItems(): SelectItem[] {
        if (scope === "scoped" && offerScope) {
          return allItems.filter((it) => scoped!.has(it.value));
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
 * Cycle to the next or previous model in pi's session scope
 * (`ctx.scopedModels`). Falls back to all available models when no scope has
 * been configured.
 */
async function cycleToModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  direction: "forward" | "backward",
): Promise<void> {
  let allModels = ctx.modelRegistry.getAvailable();
  if (allModels.length === 0) return;

  // Filter by pi's native session scope if one is configured.
  const scoped = scopedKeys(ctx);
  if (scoped !== null) {
    allModels = allModels.filter((m) => scoped.has(`${m.provider}/${m.id}`));
    if (allModels.length === 0) {
      ctx.ui.notify("No scoped models are available", "warning");
      return;
    }
  }

  if (allModels.length <= 1) {
    const label = scoped !== null ? "scope" : "available";
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
