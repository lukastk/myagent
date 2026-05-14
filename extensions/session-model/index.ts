/**
 * Session Model Extension
 *
 * Adds a `/smodel` command to switch models for the current session only,
 * without modifying settings.json. The built-in `/model` command persists
 * to settings.json; this command uses `pi.setModel()` instead.
 *
 * Usage:
 *   `/smodel`              - show a selector to pick a model
 *   `/smodel claude-sonnet` - fuzzy-match and switch directly
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Container,
  DynamicBorder,
  type SelectItem,
  SelectList,
  Text,
} from "@mariozechner/pi-tui";

interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

/**
 * Collect available models across all providers.
 */
function getAvailableModels(ctx: ExtensionCommandContext): ModelChoice[] {
  const registry = ctx.modelRegistry;
  const models: ModelChoice[] = [];

  // Iterate over all providers the registry knows about
  for (const provider of registry.listProviders()) {
    for (const model of registry.listModels(provider)) {
      models.push({
        provider,
        id: model.id,
        name: model.name || model.id,
      });
    }
  }

  return models;
}

function buildDescription(choice: ModelChoice): string {
  return `${choice.provider}/${choice.id}`;
}

/**
 * Fuzzy filter models by a query string.
 */
function fuzzyFilter(query: string, models: ModelChoice[]): ModelChoice[] {
  const q = query.toLowerCase();
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q)
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("smodel", {
    description:
      "Switch model for current session only (does not modify settings.json)",
    handler: async (args, ctx) => {
      const models = getAvailableModels(ctx);
      if (models.length === 0) {
        ctx.ui.notify("No models available", "error");
        return;
      }

      // Direct switch: /smodel <query>
      if (args?.trim()) {
        const query = args.trim();
        const matches = fuzzyFilter(query, models);

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
}

async function showSelector(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  models: ModelChoice[]
): Promise<void> {
  const items: SelectItem[] = models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: m.name,
    description: `${m.provider}/${m.id}`,
  }));

  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();

      // Border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str))
      );

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Switch Model (session only)"))
        )
      );

      // SelectList
      const selectList = new SelectList(
        items,
        Math.min(items.length, 15),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        }
      );

      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);

      container.addChild(selectList);

      // Footer
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate · enter select · esc cancel")
        )
      );

      // Bottom border
      container.addChild(
        new DynamicBorder((str) => theme.fg("accent", str))
      );

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
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
