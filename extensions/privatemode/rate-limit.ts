import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared machine-local PrivateMode request limiter.
 *
 * Pi and mypi processes coordinate through a small cache file containing only
 * timestamps and estimated token counts. Prompt and response content is never
 * persisted. The chars/4 estimate matches Pi's conservative compaction
 * heuristic; inline images use a fixed allowance instead of their base64 size.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_CACHED_TOKEN_BUDGET = 450_000;
export const RATE_LIMIT_HARD_CACHED_TOKEN_LIMIT = 500_000;
export const RATE_LIMIT_UNCACHED_TOKEN_BUDGET = 180_000;
export const RATE_LIMIT_HARD_UNCACHED_TOKEN_LIMIT = 200_000;
export const RATE_LIMIT_REQUEST_BUDGET = 35;
const RATE_LIMIT_EXPIRY_BUFFER_MS = 250;
const RATE_LIMIT_IMAGE_TOKEN_ESTIMATE = 8_192;
const RATE_LIMIT_LOCK_STALE_MS = 30_000;
const RATE_LIMIT_LOCK_TIMEOUT_MS = 10_000;
export const RATE_LIMIT_STATE_PATH = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "myagent",
  "privatemode-rate-limit.json"
);
const RATE_LIMIT_LOCK_PATH = `${RATE_LIMIT_STATE_PATH}.lock`;

export interface RateLimitReservation {
  at: number;
  tokens: number;
  /** Prompt tokens that could not use the provider prompt cache. */
  uncachedTokens?: number;
}

export interface RateLimitReservationOptions {
  uncached?: boolean;
}

interface RateLimitState {
  version: 1;
  reservations: RateLimitReservation[];
}

export interface RateLimitPlan {
  retained: RateLimitReservation[];
  usedTokens: number;
  usedUncachedTokens: number;
  requestCount: number;
  waitMs: number;
}

export interface RateLimitSnapshot {
  usedTokens: number;
  usedUncachedTokens: number;
  requestCount: number;
  nextResetMs: number;
}

function abortError(): Error {
  const error = new Error("PrivateMode rate-limit wait cancelled");
  error.name = "AbortError";
  return error;
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function estimatePrivateModePromptTokens(payload: unknown): number {
  const seen = new WeakSet<object>();
  const estimate = (value: unknown): number => {
    if (value === null || value === undefined) return 1;
    if (typeof value === "string") {
      if (/^data:image\/[^;,]+;base64,/i.test(value)) {
        return RATE_LIMIT_IMAGE_TOKEN_ESTIMATE;
      }
      return Math.max(1, Math.ceil(value.length / 4));
    }
    if (typeof value === "number" || typeof value === "boolean") return 1;
    if (typeof value !== "object") return 1;
    if (seen.has(value)) {
      throw new Error("PrivateMode request payload unexpectedly contains a cycle");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return 1 + value.reduce((sum, entry) => sum + estimate(entry) + 1, 0);
      }
      let tokens = 1;
      for (const [key, entry] of Object.entries(value)) {
        tokens += Math.max(1, Math.ceil(key.length / 4)) + estimate(entry) + 1;
      }
      return tokens;
    } finally {
      seen.delete(value);
    }
  };
  return estimate(payload);
}

/** Pure sliding-window planner used by the shared file-backed limiter. */
export function planPrivateModeRateLimit(
  reservations: readonly RateLimitReservation[],
  requestTokens: number,
  now: number,
  options: RateLimitReservationOptions = {}
): RateLimitPlan {
  if (!Number.isFinite(requestTokens) || requestTokens <= 0) {
    throw new Error(`PrivateMode token estimate must be positive, got ${requestTokens}`);
  }
  if (requestTokens > RATE_LIMIT_HARD_CACHED_TOKEN_LIMIT) {
    throw new Error(
      `PrivateMode request is estimated at ${requestTokens.toLocaleString()} prompt tokens, ` +
        `above the provider's ${RATE_LIMIT_HARD_CACHED_TOKEN_LIMIT.toLocaleString()} ` +
        "cached-token-per-minute limit. Compact or split the work before retrying."
    );
  }
  if (options.uncached && requestTokens > RATE_LIMIT_HARD_UNCACHED_TOKEN_LIMIT) {
    throw new Error(
      `PrivateMode uncached request is estimated at ${requestTokens.toLocaleString()} prompt tokens, ` +
        `above the provider's ${RATE_LIMIT_HARD_UNCACHED_TOKEN_LIMIT.toLocaleString()} ` +
        "prompt-token-per-minute limit. Split the request before retrying."
    );
  }

  const retained = reservations
    .filter(
      (entry) =>
        Number.isFinite(entry.at) &&
        Number.isFinite(entry.tokens) &&
        entry.tokens > 0 &&
        (entry.uncachedTokens === undefined ||
          (Number.isFinite(entry.uncachedTokens) && entry.uncachedTokens >= 0)) &&
        now - entry.at < RATE_LIMIT_WINDOW_MS
    )
    .sort((a, b) => a.at - b.at);
  const retainedUsedTokens = retained.reduce((sum, entry) => sum + entry.tokens, 0);
  const retainedUsedUncachedTokens = retained.reduce(
    (sum, entry) => sum + (entry.uncachedTokens ?? 0),
    0
  );
  let usedTokens = retainedUsedTokens;
  let usedUncachedTokens = retainedUsedUncachedTokens;
  let requestCount = retained.length;
  const requestUncachedTokens = options.uncached ? requestTokens : 0;
  // A single request between a safety budget and the corresponding provider hard
  // limit may run only in an otherwise empty window.
  const effectiveTokenBudget = Math.max(
    RATE_LIMIT_CACHED_TOKEN_BUDGET,
    requestTokens
  );
  const effectiveUncachedTokenBudget = Math.max(
    RATE_LIMIT_UNCACHED_TOKEN_BUDGET,
    requestUncachedTokens
  );
  const fits = () =>
    usedTokens + requestTokens <= effectiveTokenBudget &&
    usedUncachedTokens + requestUncachedTokens <= effectiveUncachedTokenBudget &&
    requestCount + 1 <= RATE_LIMIT_REQUEST_BUDGET;

  if (fits()) {
    return {
      retained,
      usedTokens,
      usedUncachedTokens,
      requestCount,
      waitMs: 0,
    };
  }

  for (const entry of retained) {
    usedTokens -= entry.tokens;
    usedUncachedTokens -= entry.uncachedTokens ?? 0;
    requestCount -= 1;
    if (fits()) {
      return {
        retained,
        usedTokens: retainedUsedTokens,
        usedUncachedTokens: retainedUsedUncachedTokens,
        requestCount: retained.length,
        waitMs: Math.max(
          1,
          entry.at + RATE_LIMIT_WINDOW_MS - now + RATE_LIMIT_EXPIRY_BUFFER_MS
        ),
      };
    }
  }

  throw new Error("PrivateMode rate limiter could not calculate a release time");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateRateLimitState(value: unknown): RateLimitState {
  if (!value || typeof value !== "object") {
    throw new Error("PrivateMode rate-limit state is not an object");
  }
  const candidate = value as Partial<RateLimitState>;
  if (candidate.version !== 1 || !Array.isArray(candidate.reservations)) {
    throw new Error("PrivateMode rate-limit state has an unsupported format");
  }
  for (const entry of candidate.reservations) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !Number.isFinite((entry as RateLimitReservation).at) ||
      !Number.isFinite((entry as RateLimitReservation).tokens) ||
      (entry as RateLimitReservation).tokens <= 0 ||
      ((entry as RateLimitReservation).uncachedTokens !== undefined &&
        (!Number.isFinite((entry as RateLimitReservation).uncachedTokens) ||
          (entry as RateLimitReservation).uncachedTokens! < 0))
    ) {
      throw new Error("PrivateMode rate-limit state contains an invalid reservation");
    }
  }
  return candidate as RateLimitState;
}

async function readRateLimitState(): Promise<RateLimitState> {
  try {
    return validateRateLimitState(JSON.parse(await readFile(RATE_LIMIT_STATE_PATH, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, reservations: [] };
    }
    throw new Error(
      `PrivateMode could not read rate-limit state ${RATE_LIMIT_STATE_PATH}: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

async function writeRateLimitState(state: RateLimitState): Promise<void> {
  await mkdir(dirname(RATE_LIMIT_STATE_PATH), { recursive: true });
  const temporary = `${RATE_LIMIT_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, RATE_LIMIT_STATE_PATH);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withRateLimitLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  await mkdir(dirname(RATE_LIMIT_LOCK_PATH), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw abortError();
    try {
      await mkdir(RATE_LIMIT_LOCK_PATH);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const lock = await stat(RATE_LIMIT_LOCK_PATH);
        if (Date.now() - lock.mtimeMs > RATE_LIMIT_LOCK_STALE_MS) {
          await rm(RATE_LIMIT_LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isNodeError(statError) || statError.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() - startedAt > RATE_LIMIT_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out acquiring shared PrivateMode rate-limit lock ${RATE_LIMIT_LOCK_PATH}`
        );
      }
      await abortableSleep(50, signal);
    }
  }

  try {
    return await operation();
  } finally {
    await rm(RATE_LIMIT_LOCK_PATH, { recursive: true, force: true });
  }
}

export async function reservePrivateModeCapacity(
  requestTokens: number,
  signal: AbortSignal | undefined,
  onWait: (waitMs: number) => void,
  options: RateLimitReservationOptions = {}
): Promise<{
  waitedMs: number;
  usedTokens: number;
  usedUncachedTokens: number;
  requestCount: number;
}> {
  const waitStartedAt = Date.now();
  let announced = false;
  for (;;) {
    const decision = await withRateLimitLock(async () => {
      const now = Date.now();
      const state = await readRateLimitState();
      const plan = planPrivateModeRateLimit(
        state.reservations,
        requestTokens,
        now,
        options
      );
      if (plan.waitMs > 0) return plan;
      const reservation: RateLimitReservation = {
        at: now,
        tokens: requestTokens,
        ...(options.uncached ? { uncachedTokens: requestTokens } : {}),
      };
      const reservations = [...plan.retained, reservation];
      await writeRateLimitState({ version: 1, reservations });
      return {
        ...plan,
        usedTokens: reservations.reduce((sum, entry) => sum + entry.tokens, 0),
        usedUncachedTokens: reservations.reduce(
          (sum, entry) => sum + (entry.uncachedTokens ?? 0),
          0
        ),
        requestCount: reservations.length,
      };
    }, signal);

    if (decision.waitMs === 0) {
      return {
        waitedMs: Date.now() - waitStartedAt,
        usedTokens: decision.usedTokens,
        usedUncachedTokens: decision.usedUncachedTokens,
        requestCount: decision.requestCount,
      };
    }
    if (!announced) {
      announced = true;
      onWait(decision.waitMs);
    }
    await abortableSleep(decision.waitMs, signal);
  }
}

export function isPrivateModeRateLimitError(errorMessage: string | undefined): boolean {
  return Boolean(
    errorMessage &&
      /\b429\b[\s\S]*(?:rate limit|tokens per minute|requests per minute)/i.test(
        errorMessage
      )
  );
}

export async function activatePrivateModeCooldown(signal?: AbortSignal): Promise<void> {
  await withRateLimitLock(async () => {
    // Full-budget reservations make following requests wait for a clean minute
    // without extending the pause because of earlier local estimates. Pause both
    // provider prompt-token buckets because the upstream 429 may name either one.
    await writeRateLimitState({
      version: 1,
      reservations: [
        {
          at: Date.now(),
          tokens: RATE_LIMIT_CACHED_TOKEN_BUDGET,
          uncachedTokens: RATE_LIMIT_UNCACHED_TOKEN_BUDGET,
        },
      ],
    });
  }, signal);
}

export async function rateLimitSnapshot(
  now = Date.now()
): Promise<RateLimitSnapshot> {
  const state = await readRateLimitState();
  const retained = state.reservations
    .filter((entry) => now - entry.at < RATE_LIMIT_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  return {
    usedTokens: retained.reduce((sum, entry) => sum + entry.tokens, 0),
    usedUncachedTokens: retained.reduce(
      (sum, entry) => sum + (entry.uncachedTokens ?? 0),
      0
    ),
    requestCount: retained.length,
    nextResetMs: retained.length
      ? Math.max(0, retained[0].at + RATE_LIMIT_WINDOW_MS - now)
      : 0,
  };
}
