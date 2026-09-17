import assert from "node:assert/strict";
import test from "node:test";
import { DarkwebError } from "../lib/core.ts";
import { onionLookup, onionSearch, ransomwareSearch, secureDropSearch } from "../lib/sources.ts";

const ONION = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion";

async function withFetch(responses: Array<unknown | Response>, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected fetch");
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await run();
    assert.equal(responses.length, 0);
  } finally {
    globalThis.fetch = original;
  }
}

test("Ahmia requests fail loudly instead of returning incomplete results", async () => {
  await assert.rejects(() => onionSearch({ query: "news", source: "ahmia" }), (error: unknown) => {
    assert.ok(error instanceof DarkwebError);
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    return true;
  });
});

test("normalizes CIRCL observations and rejects identifier mismatch", { concurrency: false }, async () => {
  await withFetch([{
    id: ONION,
    first_seen: "2026-01-01",
    last_seen: "2026-09-17",
    titles: ["\n Example \n", "Example"],
    languages: ["en"],
    tags: ["test"],
  }], async () => {
    const result = await onionLookup({ onion: ONION });
    assert.equal(result.found, true);
    assert.deepEqual(result.titles, ["Example"]);
  });

  await withFetch([{
    id: "x".repeat(56) + ".onion",
    first_seen: "2026-01-01",
    last_seen: "2026-09-17",
    titles: [],
    languages: [],
    tags: [],
  }], async () => {
    await assert.rejects(() => onionLookup({ onion: ONION }), (error: unknown) => {
      assert.ok(error instanceof DarkwebError);
      assert.equal(error.code, "UPSTREAM_SCHEMA_CHANGED");
      return true;
    });
  });
});

test("filters official SecureDrop directory fields", { concurrency: false }, async () => {
  await withFetch([[
    {
      title: "Example News",
      directory_url: "https://securedrop.org/directory/example/",
      landing_page_url: "https://example.org/securedrop/",
      onion_address: ONION,
      onion_name: null,
      organization_description: "Independent newsroom",
      organization_url: "https://example.org/",
      languages: ["English"],
      topics: ["technology"],
      countries: ["Canada"],
      latest_scan: { live: true, result_last_seen: "2026-09-17T00:00:00Z", grade: "A" },
    },
  ]], async () => {
    const result = await secureDropSearch({ country: "canada", live: true });
    assert.equal(result.result_count, 1);
    assert.equal(result.results[0].confidence, "official_securedrop_directory");
  });
});

test("normalizes two ransomware feeds while keeping dates distinct", { concurrency: false }, async () => {
  await withFetch([
    [{
      victim: "Example Corp",
      group: "group-a",
      discovered: "2026-09-17T10:00:00Z",
      attackdate: "2026-09-01 00:00:00.000000",
      country: "US",
      activity: "Technology",
      domain: "example.com",
      claim_url: "http://attacker.invalid/claim",
      url: "https://www.ransomware.live/id/example",
    }],
    { posts: [{ group_name: "group-a", post_title: "Example Corp", discovered: "2026-09-17T11:00:00Z" }] },
  ], async () => {
    const result = await ransomwareSearch({ query: "example", from: "2026-09-01", to: "2026-09-30" });
    assert.equal(result.result_count, 2);
    assert.equal(result.claims[0].evidence_status, "actor_claim_unverified");
    assert.equal(result.claims.find((claim) => claim.source === "ransomware.live")?.incident_date, "2026-09-01 00:00:00.000000");
  });
});
