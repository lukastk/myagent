import {
  DarkwebError,
  assertRecord,
  boundedLimit,
  fetchSource,
  normalizeWhitespace,
  nullableString,
  parseOnionInput,
  requiredString,
  stringArray,
  validateOnionHostname,
} from "./core.ts";

export const SOURCE_URLS = {
  rwos: "https://raw.githubusercontent.com/alecmuffett/real-world-onion-sites/master/README.md",
  ahmia: "https://ahmia.fi/",
  onionLookup: "https://onion.ail-project.org/api/lookup/",
  secureDrop: "https://securedrop.org/api/v1/directory/?format=json",
  ransomwareLive: "https://api.ransomware.live/v2/",
  ransomLook: "https://www.ransomlook.io/api/posts",
} as const;

interface RwosEntry {
  title: string;
  category: string;
  onion_url: string;
  onion_base: string;
  proof: { kind: "clearnet_link" | "tls_certificate" | "unconfirmed"; url: string | null };
  latest_check: { time: string; http_code: number; curl_exit: number; status: string } | null;
  confidence: "curated_with_proof" | "curated_unconfirmed";
}

export function parseRwos(markdown: string): RwosEntry[] {
  const entries: RwosEntry[] = [];
  let category = "";
  let current: { title: string; headingUrl: string; block: string[]; category: string } | null = null;

  const flush = () => {
    if (!current) return;
    const block = current.block.join("\n");
    const plainMatch = /^\* plain: `([^`]+)`/m.exec(block);
    const onionUrl = plainMatch?.[1] ?? current.headingUrl;
    let parsed: URL;
    try {
      parsed = new URL(onionUrl);
    } catch {
      throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `RWOS entry ${current.title} has an invalid URL`);
    }
    const labels = parsed.hostname.toLowerCase().split(".");
    if (labels.at(-1) !== "onion" || labels.length < 2) {
      throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `RWOS entry ${current.title} is not an onion URL`);
    }
    const onionBase = `${labels.at(-2)}.onion`;
    validateOnionHostname(onionBase);

    const proofLink = /^\* proof: \[link\]\((https?:\/\/[^)]+)\)/m.exec(block)?.[1] ?? null;
    const proofKind = proofLink
      ? "clearnet_link"
      : /^\* proof: :lock:/m.test(block)
        ? "tls_certificate"
        : "unconfirmed";
    const check = /^\* check: <span title="attempts=\d+ code=(\d+) exit=(\d+) time=([^"]+)">:([^:]+):<\/span>/m.exec(
      block,
    );

    entries.push({
      title: current.title,
      category: current.category,
      onion_url: onionUrl,
      onion_base: onionBase,
      proof: { kind: proofKind, url: proofLink },
      latest_check: check
        ? { http_code: Number(check[1]), curl_exit: Number(check[2]), time: check[3], status: check[4] }
        : null,
      confidence: proofKind === "unconfirmed" ? "curated_unconfirmed" : "curated_with_proof",
    });
    current = null;
  };

  for (const line of markdown.split("\n")) {
    const sectionMatch = /^## (.+)$/.exec(line);
    if (sectionMatch) {
      flush();
      category = sectionMatch[1];
      continue;
    }
    const entryMatch = /^### \[([^\]]+)\]\((https?:\/\/[^)]+\.onion[^)]*)\)$/.exec(line);
    if (entryMatch) {
      flush();
      current = { title: entryMatch[1], headingUrl: entryMatch[2], block: [], category };
      continue;
    }
    current?.block.push(line);
  }
  flush();
  return entries;
}

export async function onionSearch(params: {
  query: string;
  source?: "rwos" | "ahmia" | "all";
  limit?: number;
}) {
  const source = params.source ?? "rwos";
  if (source === "ahmia" || source === "all") {
    throw new DarkwebError(
      "SOURCE_UNAVAILABLE",
      "Ahmia currently requires a JavaScript/dynamic anti-automation flow; this static tool will not bypass it or return misleading empty results",
      { source: SOURCE_URLS.ahmia },
    );
  }

  const query = params.query.trim().toLowerCase();
  if (!query) throw new DarkwebError("SOURCE_UNAVAILABLE", "query must not be empty");
  const limit = boundedLimit(params.limit, 20);
  const response = await fetchSource(SOURCE_URLS.rwos, { responseType: "text" });
  if (typeof response.data !== "string") {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "RWOS returned non-text content");
  }
  const matches = parseRwos(response.data).filter((entry) =>
    [entry.title, entry.category, entry.onion_url, entry.proof.url ?? ""].some((field) =>
      field.toLowerCase().includes(query),
    ),
  );
  const byOnion = new Map<string, RwosEntry[]>();
  for (const entry of matches) {
    byOnion.set(entry.onion_base, [...(byOnion.get(entry.onion_base) ?? []), entry]);
  }
  const results = [...byOnion.entries()].slice(0, limit).map(([onion, records]) => ({
    onion,
    title: records[0].title,
    onion_url: records[0].onion_url,
    confidence: records.some((record) => record.confidence === "curated_with_proof")
      ? "curated_with_proof"
      : "curated_unconfirmed",
    records,
  }));

  return {
    query: params.query,
    source: "real_world_onion_sites",
    source_url: SOURCE_URLS.rwos,
    fetched_at: response.fetchedAt,
    result_count: results.length,
    source_record_count: matches.length,
    results,
    caveat: "Curation and reachability checks are evidence, not proof that a service is safe or currently controlled by its claimed operator.",
  };
}

export async function onionLookup(params: { onion: string }) {
  const onion = parseOnionInput(params.onion).hostname;
  const response = await fetchSource(`${SOURCE_URLS.onionLookup}${encodeURIComponent(onion)}`, {
    responseType: "json",
    allowNotFound: true,
  });
  assertRecord(response.data, "CIRCL Onion-Lookup");
  const notFound = response.status === 404 || response.data.error === "domain not found";
  if (notFound) {
    if (response.data.domain !== undefined && response.data.domain !== onion) {
      throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "CIRCL Onion-Lookup not-found response named a different onion");
    }
    return {
      onion,
      found: false,
      source: "circl_ail_onion_lookup",
      source_url: `${SOURCE_URLS.onionLookup}${onion}`,
      fetched_at: response.fetchedAt,
      caveat: "Not found means absent from this AIL index, not that the onion service does not exist.",
    };
  }

  const id = requiredString(response.data, "id", "CIRCL Onion-Lookup").toLowerCase();
  if (id !== onion) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "CIRCL Onion-Lookup returned a different onion identifier");
  }
  const titles = stringArray(response.data, "titles", "CIRCL Onion-Lookup")
    .map(normalizeWhitespace)
    .filter((title, index, all) => title.length > 0 && all.indexOf(title) === index);
  const knownFields = new Set(["id", "first_seen", "last_seen", "titles", "languages", "tags"]);
  const unrecognizedFields = Object.fromEntries(
    Object.entries(response.data).filter(([field]) => !knownFields.has(field)),
  );
  if (JSON.stringify(unrecognizedFields).length > 65_536) {
    throw new DarkwebError("RESPONSE_TOO_LARGE", "CIRCL Onion-Lookup diagnostic fields exceeded 65536 characters");
  }

  return {
    onion,
    found: true,
    first_seen: requiredString(response.data, "first_seen", "CIRCL Onion-Lookup"),
    last_seen: requiredString(response.data, "last_seen", "CIRCL Onion-Lookup"),
    titles,
    languages: stringArray(response.data, "languages", "CIRCL Onion-Lookup"),
    tags: stringArray(response.data, "tags", "CIRCL Onion-Lookup"),
    unrecognized_fields: unrecognizedFields,
    source: "circl_ail_onion_lookup",
    source_url: `${SOURCE_URLS.onionLookup}${onion}`,
    fetched_at: response.fetchedAt,
    confidence: "observed_by_ail",
    caveat: "Observed metadata is untrusted index evidence; it does not establish ownership, legality, safety, or present availability.",
  };
}

function optionalStringArray(record: Record<string, unknown>, field: string, source: string): string[] {
  const value = record[field];
  if (value === undefined) return [];
  return stringArray(record, field, source);
}

export async function secureDropSearch(params: {
  organization?: string;
  country?: string;
  language?: string;
  topic?: string;
  live?: boolean;
  limit?: number;
}) {
  const limit = boundedLimit(params.limit, 25);
  const response = await fetchSource(SOURCE_URLS.secureDrop, { responseType: "json" });
  if (!Array.isArray(response.data)) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "SecureDrop directory response is not an array");
  }

  const normalized = response.data.map((value) => {
    assertRecord(value, "SecureDrop directory");
    const latestScan = value.latest_scan;
    assertRecord(latestScan, "SecureDrop latest_scan");
    if (typeof latestScan.live !== "boolean") {
      throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "SecureDrop latest_scan.live is not boolean");
    }
    const onion = requiredString(value, "onion_address", "SecureDrop directory").toLowerCase();
    validateOnionHostname(onion);
    return {
      organization: requiredString(value, "title", "SecureDrop directory"),
      onion,
      onion_url: `http://${onion}`,
      onion_name: nullableString(value, "onion_name", "SecureDrop directory"),
      directory_url: requiredString(value, "directory_url", "SecureDrop directory"),
      landing_page_url: requiredString(value, "landing_page_url", "SecureDrop directory"),
      organization_url: requiredString(value, "organization_url", "SecureDrop directory"),
      description: requiredString(value, "organization_description", "SecureDrop directory"),
      countries: optionalStringArray(value, "countries", "SecureDrop directory"),
      languages: optionalStringArray(value, "languages", "SecureDrop directory"),
      topics: optionalStringArray(value, "topics", "SecureDrop directory"),
      status: {
        live: latestScan.live,
        last_seen: requiredString(latestScan, "result_last_seen", "SecureDrop latest_scan"),
        grade: requiredString(latestScan, "grade", "SecureDrop latest_scan"),
      },
      confidence: "official_securedrop_directory",
    };
  });

  const includes = (values: string[], wanted: string | undefined) =>
    !wanted || values.some((value) => value.toLowerCase() === wanted.trim().toLowerCase());
  const organization = params.organization?.trim().toLowerCase();
  const results = normalized
    .filter((entry) => !organization || entry.organization.toLowerCase().includes(organization))
    .filter((entry) => includes(entry.countries, params.country))
    .filter((entry) => includes(entry.languages, params.language))
    .filter((entry) => includes(entry.topics, params.topic))
    .filter((entry) => params.live === undefined || entry.status.live === params.live)
    .sort((a, b) => a.organization.localeCompare(b.organization))
    .slice(0, limit);

  return {
    source: "securedrop_official_directory",
    source_url: SOURCE_URLS.secureDrop,
    fetched_at: response.fetchedAt,
    result_count: results.length,
    results,
    caveat: "Use Tor Browser at its Safest security level for actual source submissions; this tool only searches public directory metadata.",
  };
}

interface RansomwareClaim {
  source: "ransomware.live" | "RansomLook";
  victim: string;
  group: string;
  discovered_at: string;
  incident_date: string | null;
  country: string | null;
  sector: string | null;
  domain: string | null;
  claim_url: string | null;
  source_url: string;
  evidence_status: "actor_claim_unverified";
  confidence: "aggregator_report_of_actor_claim";
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isCalendarDate(value)) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", `${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function upstreamTimestamp(value: string, source: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `${source} field ${field} is not a valid timestamp`);
  }
  return value;
}

function upstreamIncidentDate(value: string): string {
  if (!isCalendarDate(value.slice(0, 10))) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "ransomware.live field attackdate is not a valid date");
  }
  return value;
}

function inDateRange(claim: RansomwareClaim, from: string | undefined, to: string | undefined): boolean {
  const day = claim.discovered_at.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

async function ransomwareLiveClaims(params: { query?: string; group?: string }): Promise<RansomwareClaim[]> {
  let endpoint: string;
  if (params.query?.trim()) {
    endpoint = `searchvictims/${encodeURIComponent(params.query.trim())}`;
  } else if (params.group?.trim()) {
    endpoint = `groupvictims/${encodeURIComponent(params.group.trim())}`;
  } else {
    endpoint = "recentvictims";
  }
  const sourceUrl = `${SOURCE_URLS.ransomwareLive}${endpoint}`;
  const response = await fetchSource(sourceUrl, { responseType: "json" });
  if (!Array.isArray(response.data)) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "ransomware.live response is not an array");
  }
  return response.data.map((value) => {
    assertRecord(value, "ransomware.live");
    const claimUrl = requiredString(value, "claim_url", "ransomware.live");
    const country = requiredString(value, "country", "ransomware.live");
    const sector = requiredString(value, "activity", "ransomware.live");
    const domain = requiredString(value, "domain", "ransomware.live");
    const discovered = requiredString(value, "discovered", "ransomware.live");
    const incidentDate = requiredString(value, "attackdate", "ransomware.live");
    return {
      source: "ransomware.live",
      victim: requiredString(value, "victim", "ransomware.live"),
      group: requiredString(value, "group", "ransomware.live"),
      discovered_at: upstreamTimestamp(discovered, "ransomware.live", "discovered"),
      incident_date: upstreamIncidentDate(incidentDate),
      country: country || null,
      sector: sector || null,
      domain: domain || null,
      claim_url: claimUrl || null,
      source_url: requiredString(value, "url", "ransomware.live"),
      evidence_status: "actor_claim_unverified",
      confidence: "aggregator_report_of_actor_claim",
    };
  });
}

async function ransomLookClaims(params: {
  from?: string;
  to?: string;
  group?: string;
}): Promise<RansomwareClaim[]> {
  const url = new URL(SOURCE_URLS.ransomLook);
  if (params.from && params.to) {
    url.searchParams.set("from", params.from);
    url.searchParams.set("to", params.to);
  } else {
    url.searchParams.set("days", "30");
  }
  if (params.group?.trim()) url.searchParams.set("groups", params.group.trim());
  const response = await fetchSource(url, { responseType: "json" });
  assertRecord(response.data, "RansomLook");
  if (!Array.isArray(response.data.posts)) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "RansomLook field posts is not an array");
  }
  return response.data.posts.map((value) => {
    assertRecord(value, "RansomLook post");
    const discovered = requiredString(value, "discovered", "RansomLook post");
    return {
      source: "RansomLook",
      victim: requiredString(value, "post_title", "RansomLook post"),
      group: requiredString(value, "group_name", "RansomLook post"),
      discovered_at: upstreamTimestamp(discovered, "RansomLook post", "discovered"),
      incident_date: null,
      country: null,
      sector: null,
      domain: null,
      claim_url: null,
      source_url: "https://www.ransomlook.io/",
      evidence_status: "actor_claim_unverified",
      confidence: "aggregator_report_of_actor_claim",
    };
  });
}

export async function ransomwareSearch(params: {
  query?: string;
  group?: string;
  from?: string;
  to?: string;
  sources?: Array<"ransomware.live" | "ransomlook">;
  limit?: number;
}) {
  const from = validateDate(params.from, "from");
  const to = validateDate(params.to, "to");
  if ((from && !to) || (to && !from)) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", "from and to must be supplied together");
  }
  if (from && to && from > to) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", "from must not be after to");
  }
  const limit = boundedLimit(params.limit, 50);
  const selected = params.sources ?? ["ransomware.live", "ransomlook"];
  if (selected.length === 0) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", "sources must contain at least one source");
  }

  const claims: RansomwareClaim[] = [];
  if (selected.includes("ransomware.live")) claims.push(...(await ransomwareLiveClaims(params)));
  if (selected.includes("ransomlook")) claims.push(...(await ransomLookClaims({ from, to, group: params.group })));

  const query = params.query?.trim().toLowerCase();
  const group = params.group?.trim().toLowerCase();
  const filtered = claims
    .filter((claim) => !query || [claim.victim, claim.domain ?? ""].some((value) => value.toLowerCase().includes(query)))
    .filter((claim) => !group || claim.group.toLowerCase() === group)
    .filter((claim) => inDateRange(claim, from, to))
    .sort((a, b) => b.discovered_at.localeCompare(a.discovered_at));

  const byVictim = new Map<string, RansomwareClaim[]>();
  for (const claim of filtered) {
    const key = claim.victim.toLowerCase().replace(/[^a-z0-9]+/g, "");
    byVictim.set(key, [...(byVictim.get(key) ?? []), claim]);
  }
  const discrepancies = [...byVictim.values()]
    .filter((matches) => matches.length > 1)
    .filter((matches) => new Set(matches.map((claim) => `${claim.group.toLowerCase()}|${claim.discovered_at.slice(0, 10)}`)).size > 1)
    .map((matches) => ({
      victim: matches[0].victim,
      reports: matches.map((claim) => ({ source: claim.source, group: claim.group, discovered_at: claim.discovered_at })),
      note: "Sources disagree or report multiple actor claims; corroborate independently.",
    }));

  return {
    sources: selected,
    result_count: Math.min(filtered.length, limit),
    total_matching: filtered.length,
    claims: filtered.slice(0, limit),
    discrepancies,
    warning: "Actor claim; not independently verified.",
    caveat: "These are unverified actor claims reported by aggregators, not confirmed incidents. Do not treat dates, attribution, victim identity, or availability as established facts without corroboration.",
    coverage: selected.includes("ransomware.live") && !params.query && !params.group
      ? "ransomware.live contributes only its recent-victims feed; RansomLook applies the requested date window or defaults to 30 days."
      : "Queries use ransomware.live's victim search and local filtering of RansomLook's date-bounded posts feed.",
  };
}
