import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DarkwebError } from "../lib/core.ts";
import { breachSearch } from "../lib/breach.ts";

function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
}

function rangeResponse(lines: string[], status = 200): Response {
  return new Response(lines.join("\n"), { status, headers: { "Content-Type": "text/plain" } });
}

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

test("password hit returns the corpus count without transmitting the full hash", async () => {
  const digest = sha1Hex("hunter2");
  const suffix = digest.slice(5);
  await withFetch([rangeResponse([`${"A".repeat(35)}:9`, `${suffix}:42`])], async () => {
    const result = await breachSearch({ password: "hunter2" });
    assert.equal(result.password?.found, true);
    assert.equal(result.password?.breach_count, 42);
    assert.equal(result.password?.sha1_prefix_sent, digest.slice(0, 5));
    assert.equal(result.password?.padding_requested, false);
  });
});

test("password miss reports not found", async () => {
  await withFetch([rangeResponse([`${"B".repeat(35)}:3`, `${"C".repeat(35)}:8`])], async () => {
    const result = await breachSearch({ password: "hunter2" });
    assert.equal(result.password?.found, false);
    assert.equal(result.password?.breach_count, null);
  });
});

test("unparseable range response fails loudly", async () => {
  await withFetch([new Response("garbage", { status: 200, headers: { "Content-Type": "text/plain" } })], async () => {
    await assert.rejects(() => breachSearch({ password: "hunter2" }), (error: unknown) => {
      assert.ok(error instanceof DarkwebError);
      assert.equal(error.code, "UPSTREAM_SCHEMA_CHANGED");
      return true;
    });
  });
});

test("account search without HIBP_API_KEY fails loudly as API_KEY_MISSING", { concurrency: false }, async () => {
  const saved = process.env.HIBP_API_KEY;
  delete process.env.HIBP_API_KEY;
  try {
    await assert.rejects(() => breachSearch({ email: "user@example.com" }), (error: unknown) => {
      assert.ok(error instanceof DarkwebError);
      assert.equal(error.code, "API_KEY_MISSING");
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.HIBP_API_KEY = saved;
  }
});

test("account search normalizes HIBP breach records", { concurrency: false }, async () => {
  const saved = process.env.HIBP_API_KEY;
  process.env.HIBP_API_KEY = "test-key";
  try {
    await withFetch(
      [
        [
          {
            Name: "Example",
            Title: "Example",
            Domain: "example.com",
            BreachDate: "2020-01-01",
            AddedDate: "2020-02-02",
            PwnCount: 5,
            DataClasses: ["Email addresses", "Password hashes"],
            IsVerified: true,
            IsSensitive: false,
          },
        ],
      ],
      async () => {
        const result = await breachSearch({ email: "user@example.com" });
        assert.equal(result.email?.found, true);
        assert.equal(result.email?.breach_count, 1);
        assert.deepEqual(result.email?.breaches[0]?.data_classes, ["Email addresses", "Password hashes"]);
        assert.equal(result.email?.breaches[0]?.is_verified, true);
      },
    );
  } finally {
    if (saved !== undefined) process.env.HIBP_API_KEY = saved;
    else delete process.env.HIBP_API_KEY;
  }
});

test("account search reports a 404 as no known breaches", { concurrency: false }, async () => {
  const saved = process.env.HIBP_API_KEY;
  process.env.HIBP_API_KEY = "test-key";
  try {
    await withFetch([new Response("", { status: 404, headers: { "Content-Type": "application/json" } })], async () => {
      const result = await breachSearch({ email: "user@example.com" });
      assert.equal(result.email?.found, false);
      assert.equal(result.email?.breach_count, 0);
      assert.deepEqual(result.email?.breaches, []);
    });
  } finally {
    if (saved !== undefined) process.env.HIBP_API_KEY = saved;
    else delete process.env.HIBP_API_KEY;
  }
});

test("non-boolean upstream field fails loudly", { concurrency: false }, async () => {
  const saved = process.env.HIBP_API_KEY;
  process.env.HIBP_API_KEY = "test-key";
  try {
    await withFetch(
      [
        [
          {
            Name: "Example",
            Title: "Example",
            Domain: "example.com",
            BreachDate: "2020-01-01",
            AddedDate: "2020-02-02",
            PwnCount: 5,
            DataClasses: [],
            IsVerified: "yes",
            IsSensitive: false,
          },
        ],
      ],
      async () => {
        await assert.rejects(() => breachSearch({ email: "user@example.com" }), (error: unknown) => {
          assert.ok(error instanceof DarkwebError);
          assert.equal(error.code, "UPSTREAM_SCHEMA_CHANGED");
          return true;
        });
      },
    );
  } finally {
    if (saved !== undefined) process.env.HIBP_API_KEY = saved;
    else delete process.env.HIBP_API_KEY;
  }
});

test("neither password nor email fails loudly", async () => {
  await assert.rejects(() => breachSearch({}), (error: unknown) => {
    assert.ok(error instanceof DarkwebError);
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    return true;
  });
});
