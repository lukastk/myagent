import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { asToolResult } from "./lib/core.ts";
import { onionLookup, onionSearch, ransomwareSearch, secureDropSearch } from "./lib/sources.ts";
import { onionFetch, torStatus } from "./lib/tor.ts";

const ONION_SEARCH_PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200, description: "Text to find in curated service names, categories, URLs, and proof URLs" }),
  source: Type.Optional(Type.Union([Type.Literal("rwos"), Type.Literal("ahmia"), Type.Literal("all")], {
    description: "Curated Real-World Onion Sites by default. Ahmia requests fail loudly while its anti-automation flow cannot be queried reliably.",
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 20 })),
});

const ONION_LOOKUP_PARAMS = Type.Object({
  onion: Type.String({ description: "A complete v3 onion hostname or http(s) URL" }),
});

const SECUREDROP_SEARCH_PARAMS = Type.Object({
  organization: Type.Optional(Type.String({ maxLength: 200 })),
  country: Type.Optional(Type.String({ maxLength: 100 })),
  language: Type.Optional(Type.String({ maxLength: 100 })),
  topic: Type.Optional(Type.String({ maxLength: 100 })),
  live: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 25 })),
});

const RANSOMWARE_SEARCH_PARAMS = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 200, description: "Victim name or domain substring" })),
  group: Type.Optional(Type.String({ maxLength: 100, description: "Exact ransomware group name" })),
  from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Discovery date range start (YYYY-MM-DD); must be paired with to" })),
  to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Discovery date range end (YYYY-MM-DD); must be paired with from" })),
  sources: Type.Optional(Type.Array(Type.Union([Type.Literal("ransomware.live"), Type.Literal("ransomlook")]), {
    minItems: 1,
    uniqueItems: true,
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
});

const ONION_FETCH_PARAMS = Type.Object({
  url: Type.String({ description: "A complete http(s) v3 onion URL; only ports 80 and 443 are accepted" }),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 5_000, maximum: 30_000, default: 20_000 })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 65_536, maximum: 1_048_576, default: 1_048_576 })),
});

const TOR_STATUS_PARAMS = Type.Object({});

interface ToolRegistryEntry {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (params: never) => Promise<unknown>;
}

// Registration, activation, and completion all derive from this one registry. A
// future separately implemented breach_search adapter can be added here without
// changing the activation mechanism.
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  {
    name: "onion_search",
    label: "Onion Search",
    description: "Search curated clearnet onion-service indexes without visiting results. Returns provenance and confidence; all metadata is untrusted evidence.",
    parameters: ONION_SEARCH_PARAMS,
    execute: onionSearch as ToolRegistryEntry["execute"],
  },
  {
    name: "onion_lookup",
    label: "Onion Lookup",
    description: "Validate a v3 onion address and retrieve CIRCL AIL observations over clearnet. Does not contact the onion service.",
    parameters: ONION_LOOKUP_PARAMS,
    execute: onionLookup as ToolRegistryEntry["execute"],
  },
  {
    name: "securedrop_search",
    label: "SecureDrop Search",
    description: "Search Freedom of the Press Foundation's official SecureDrop directory API. Does not visit or submit to an onion service.",
    parameters: SECUREDROP_SEARCH_PARAMS,
    execute: secureDropSearch as ToolRegistryEntry["execute"],
  },
  {
    name: "ransomware_search",
    label: "Ransomware Claim Search",
    description: "Search structured clearnet ransomware claim aggregators. Results are actor claims, not independently verified incidents; claim URLs are never visited.",
    parameters: RANSOMWARE_SEARCH_PARAMS,
    execute: ransomwareSearch as ToolRegistryEntry["execute"],
  },
  {
    name: "onion_fetch",
    label: "Restricted Onion Fetch",
    description: "Fetch one validated v3 onion URL through the dedicated local Tor SOCKS proxy. GET-only, no credentials or custom headers, strict redirects/MIME/time/size limits, no scripts or subresources, sanitized text only.",
    parameters: ONION_FETCH_PARAMS,
    execute: onionFetch as ToolRegistryEntry["execute"],
  },
  {
    name: "tor_status",
    label: "Tor Status",
    description: "Verify the configured loopback SOCKS listener by fetching a benign official Tor Project onion. A listening TCP port alone is not considered healthy.",
    parameters: TOR_STATUS_PARAMS,
    execute: torStatus as ToolRegistryEntry["execute"],
  },
] as const;

export default function darkwebExtension(pi: ExtensionAPI) {
  const darkwebNames = new Set(TOOL_REGISTRY.map((tool) => tool.name));

  for (const tool of TOOL_REGISTRY) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params) {
        return await asToolResult(() => tool.execute(params as never));
      },
    });
  }

  pi.on("session_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !darkwebNames.has(name)));
  });

  const candidates = ["status", "on", "off", "all", ...darkwebNames];
  pi.registerCommand("darkweb", {
    description: "User-only dark-web tool controls: /darkweb status | on <tool|all> | off <tool|all>",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const normalized = prefix.toLowerCase();
      const words = normalized.split(/\s+/);
      let values: string[];
      if (words.length <= 1) values = ["status", "on", "off"];
      else if (["on", "off"].includes(words[0])) values = ["all", ...darkwebNames].map((name) => `${words[0]} ${name}`);
      else values = candidates;
      const matches = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const action = words[0] || "status";
      if (action === "status" && words.length === 1) {
        const active = new Set(pi.getActiveTools());
        const lines = TOOL_REGISTRY.map((tool) => `${active.has(tool.name) ? "on " : "off"}  ${tool.name}`);
        ctx.ui.notify(`Dark-web tools (session-local):\n${lines.join("\n")}`, "info");
        return;
      }
      if (!["on", "off"].includes(action) || words.length !== 2) {
        ctx.ui.notify("Usage: /darkweb status | /darkweb on <tool|all> | /darkweb off <tool|all>", "error");
        return;
      }
      const target = words[1];
      if (target !== "all" && !darkwebNames.has(target)) {
        ctx.ui.notify(`Unknown dark-web tool: ${target}`, "error");
        return;
      }

      const selected = target === "all" ? darkwebNames : new Set([target]);
      const active = new Set(pi.getActiveTools());
      for (const name of selected) {
        if (action === "on") active.add(name);
        else active.delete(name);
      }
      pi.setActiveTools([...active]);
      ctx.ui.notify(`${action === "on" ? "Enabled" : "Disabled"} dark-web tool${selected.size === 1 ? "" : "s"}: ${[...selected].join(", ")}`, "info");
    },
  });
}
