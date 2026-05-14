/**
 * Session Model Extension
 *
 * Adds a `/smodel` command to switch models for the current session only,
 * without modifying settings.json. The built-in `/model` command persists
 * to settings.json; this command uses `pi.setModel()` instead.
 *
 * Also adds keyboard shortcuts for quick model cycling:
 *   Ctrl+Alt+P       - cycle to next available model
 *   Shift+Ctrl+Alt+P - cycle to previous available model
 *
 * Usage:
 *   `/smodel`              - show a selector to pick a model
 *   `/smodel claude-sonnet` - fuzzy-match and switch directly
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
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

/**
 * Collect available models across all providers.
 * Uses getAvailable() which only returns models with valid API keys.
 */
async function getAvailableModels(ctx: ExtensionCommandContext): Promise<ModelChoice[]> {
  const available = await ctx.modelRegistry.getAvailable();
  return available.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name || m.id,
  }));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("smodel", {
    description:
      "Switch model for current session only (does not modify settings.json)",
    handler: async (args, ctx) => {
      const models = await getAvailableModels(ctx);
      if (models.length === 0) {
        ctx.ui.notify("No models available", "error");
        return;
      }

      // Direct switch: /smodel <query>
      if (args?.trim()) {
        const query = args.trim();
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
                "info"
              );
            } else {
              ctx.ui.notify(
                `No API key for ${choice.provider}/${choice.id}`,
                "error"
              );
            }
          }
          return;
        }

        // Multiple matches: show selector filtered to matches
        await showSelector(ctx, pi, matches);
        return;
      }

      // No args: show full selector
      await showSelector(ctx, pi, models);
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
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  models: ModelChoice[]
): Promise<void> {
  const allItems: SelectItem[] = models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: m.name,
    description: `${m.provider}/${m.id}`,
  }));

  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      let searchQuery = "";

      function filteredItems(): SelectItem[] {
        if (!searchQuery) return allItems;
        return fuzzyFilter(allItems, searchQuery, (item) => `${item.label} ${item.description ?? ""}`);
      }

      const container = new Container();

      // Top border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str))
      );

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Switch Model (session only)"))
        )
      );

      // Search display (Text that updates as user types)
      const searchText = new Text(
        theme.fg("muted", "Type to search..."),
        0,
        0
      );
      container.addChild(searchText);

      // Build initial SelectList
      let selectList = buildSelectList(filteredItems(), theme, done);
      container.addChild(selectList);

      function buildSelectList(
        items: SelectItem[],
        theme: any,
        done: (value: string | null) => void
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
            done
          );
          selectList = container.children[idx] as SelectList;
        }
        container.invalidate();
      }

      // Footer
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate · enter select · esc cancel · type to search")
        )
      );

      // Bottom border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str))
      );

      function updateSearchDisplay() {
        if (searchQuery) {
          searchText.setText(
            theme.fg("accent", `Search: ${searchQuery}`)
          );
        } else {
          searchText.setText(theme.fg("muted", "Type to search..."));
        }
        searchText.invalidate();
      }

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
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
    }
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
        "info"
      );
    } else {
      ctx.ui.notify(`No API key for ${provider}/${id}`, "error");
    }
  }
}

/**
 * Cycle to the next or previous available model (session only).
 * Uses ctx.modelRegistry.getAvailable() which returns only models with valid API keys.
 */
async function cycleToModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  direction: "forward" | "backward"
): Promise<void> {
  const models = ctx.modelRegistry.getAvailable();
  if (models.length <= 1) return;

  const currentModel = ctx.model;
  let currentIndex = -1;
  if (currentModel) {
    currentIndex = models.findIndex(
      (m) => m.provider === currentModel.provider && m.id === currentModel.id
    );
  }
  if (currentIndex === -1) currentIndex = 0;

  const len = models.length;
  const nextIndex =
    direction === "forward"
      ? (currentIndex + 1) % len
      : (currentIndex - 1 + len) % len;

  const nextModel = models[nextIndex];
  const success = await pi.setModel(nextModel);
  if (success) {
    const thinkingStr =
      nextModel.reasoning ? ` (thinking: ${nextModel.reasoning})` : "";
    const displayName = nextModel.name || nextModel.id;
    ctx.ui.notify(
      `Switched to ${nextModel.provider}/${displayName}${thinkingStr} (session only)`,
      "info"
    );
  }
}
