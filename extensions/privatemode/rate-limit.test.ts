import assert from "node:assert/strict";
import test from "node:test";

import {
  RATE_LIMIT_CACHED_TOKEN_BUDGET,
  RATE_LIMIT_HARD_CACHED_TOKEN_LIMIT,
  RATE_LIMIT_HARD_UNCACHED_TOKEN_LIMIT,
  RATE_LIMIT_UNCACHED_TOKEN_BUDGET,
  RATE_LIMIT_WINDOW_MS,
  estimatePrivateModePromptTokens,
  isPrivateModeRateLimitError,
  planPrivateModeRateLimit,
} from "./rate-limit.ts";

test("payload estimator treats long text conservatively without counting base64 bytes", () => {
  const longText = "x".repeat(640_000);
  const textEstimate = estimatePrivateModePromptTokens({
    model: "glm-5.3",
    messages: [{ role: "user", content: longText }],
  });
  assert.ok(textEstimate >= 160_000);
  assert.ok(textEstimate < 161_000);

  const shortImage = estimatePrivateModePromptTokens({
    image_url: { url: `data:image/png;base64,${"A".repeat(100)}` },
  });
  const hugeImage = estimatePrivateModePromptTokens({
    image_url: { url: `data:image/png;base64,${"A".repeat(2_000_000)}` },
  });
  assert.equal(shortImage, hugeImage);
  assert.ok(hugeImage < 10_000);
});

test("rate limiter queues a request that would cross the safety budget", () => {
  const now = 1_000_000;
  const requestTokens = 160_000;
  const reservations = [
    { at: now - 20_000, tokens: requestTokens },
    { at: now - 10_000, tokens: requestTokens },
  ];
  const plan = planPrivateModeRateLimit(reservations, requestTokens, now);
  assert.ok(2 * requestTokens < RATE_LIMIT_CACHED_TOKEN_BUDGET);
  assert.ok(3 * requestTokens > RATE_LIMIT_CACHED_TOKEN_BUDGET);
  assert.equal(plan.waitMs, 40_250);
  assert.equal(plan.usedTokens, 320_000);
  assert.equal(plan.requestCount, 2);
});

test("rate limiter releases expired reservations and permits the next request", () => {
  const now = 2_000_000;
  const plan = planPrivateModeRateLimit(
    [
      { at: now - RATE_LIMIT_WINDOW_MS, tokens: 300_000 },
      { at: now - 5_000, tokens: 100_000 },
    ],
    200_000,
    now
  );
  assert.equal(plan.waitMs, 0);
  assert.equal(plan.usedTokens, 100_000);
  assert.equal(plan.requestCount, 1);
});

test("rate limiter rejects a single request above the provider hard limit", () => {
  assert.throws(
    () =>
      planPrivateModeRateLimit([], RATE_LIMIT_HARD_CACHED_TOKEN_LIMIT + 1, Date.now()),
    /Compact or split the work/
  );
});

test("uncached summary requests use the separate prompt-token budget", () => {
  const now = 3_000_000;
  const requestTokens = 100_000;
  const plan = planPrivateModeRateLimit(
    [{ at: now - 10_000, tokens: requestTokens, uncachedTokens: requestTokens }],
    requestTokens,
    now,
    { uncached: true }
  );
  assert.ok(requestTokens < RATE_LIMIT_UNCACHED_TOKEN_BUDGET);
  assert.ok(2 * requestTokens > RATE_LIMIT_UNCACHED_TOKEN_BUDGET);
  assert.equal(plan.waitMs, 50_250);
  assert.equal(plan.usedUncachedTokens, requestTokens);
});

test("uncached summary requests reject a single payload above 200k", () => {
  assert.throws(
    () =>
      planPrivateModeRateLimit(
        [],
        RATE_LIMIT_HARD_UNCACHED_TOKEN_LIMIT + 1,
        Date.now(),
        { uncached: true }
      ),
    /prompt-token-per-minute limit/
  );
});

test("rate-limit classifier recognizes the upstream PrivateMode 429", () => {
  assert.equal(
    isPrivateModeRateLimitError(
      '429: {"message":"request rejected: your request would exceed the configured rate limit of 500000 cached prompt tokens per minute"}'
    ),
    true
  );
  assert.equal(isPrivateModeRateLimitError("500: upstream unavailable"), false);
  assert.equal(isPrivateModeRateLimitError(undefined), false);
});
