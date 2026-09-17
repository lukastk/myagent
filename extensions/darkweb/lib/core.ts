import { createHash } from "node:crypto";

export const SOURCE_TIMEOUT_MS = 20_000;
export const SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_RESULTS = 100;

export type ErrorCode =
  | "TOR_UNAVAILABLE"
  | "INVALID_ONION_V3"
  | "REDIRECT_BLOCKED"
  | "CONTENT_TYPE_BLOCKED"
  | "RESPONSE_TOO_LARGE"
  | "FETCH_TIMEOUT"
  | "UPSTREAM_SCHEMA_CHANGED"
  | "SOURCE_UNAVAILABLE"
  | "AUDIT_WRITE_FAILED";

export class DarkwebError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DarkwebError";
    this.code = code;
    this.details = details;
  }
}

export function serializeError(error: unknown): string {
  if (error instanceof DarkwebError) {
    return JSON.stringify(
      { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
      null,
      2,
    );
  }
  if (error instanceof Error) {
    return JSON.stringify({ error: { code: "SOURCE_UNAVAILABLE", message: error.message } }, null, 2);
  }
  return JSON.stringify({ error: { code: "SOURCE_UNAVAILABLE", message: String(error) } }, null, 2);
}

export async function asToolResult(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      details: value,
    };
  } catch (error) {
    throw new Error(serializeError(error));
  }
}

function decodeBase32(input: string): Buffer {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const character of input) {
    const value = alphabet.indexOf(character);
    if (value < 0) {
      throw new DarkwebError("INVALID_ONION_V3", "Onion hostname contains a non-base32 character");
    }
    accumulator = (accumulator << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }

  if (bits !== 0 || bytes.length !== 35) {
    throw new DarkwebError("INVALID_ONION_V3", "Onion hostname does not decode to a v3 onion address");
  }
  return Buffer.from(bytes);
}

export interface ValidatedOnion {
  hostname: string;
  label: string;
}

export function validateOnionHostname(hostname: string): ValidatedOnion {
  const canonical = hostname.toLowerCase();
  const match = /^([a-z2-7]{56})\.onion$/.exec(canonical);
  if (!match) {
    throw new DarkwebError(
      "INVALID_ONION_V3",
      "Expected exactly one 56-character RFC 4648 base32 label followed by .onion",
    );
  }

  const decoded = decodeBase32(match[1]);
  const publicKey = decoded.subarray(0, 32);
  const checksum = decoded.subarray(32, 34);
  const version = decoded[34];
  if (version !== 0x03) {
    throw new DarkwebError("INVALID_ONION_V3", `Unsupported onion version byte: ${version}`);
  }

  const expectedChecksum = createHash("sha3-256")
    .update(Buffer.from(".onion checksum", "ascii"))
    .update(publicKey)
    .update(Buffer.from([version]))
    .digest()
    .subarray(0, 2);
  if (!checksum.equals(expectedChecksum)) {
    throw new DarkwebError("INVALID_ONION_V3", "Onion v3 checksum validation failed");
  }

  return { hostname: canonical, label: match[1] };
}

export interface ValidatedOnionUrl extends ValidatedOnion {
  url: URL;
}

export function validateOnionUrl(input: string, options: { allowBareHostname?: boolean } = {}): ValidatedOnionUrl {
  let url: URL;
  try {
    if (options.allowBareHostname && !input.includes("://")) {
      url = new URL(`http://${input}`);
    } else {
      url = new URL(input);
    }
  } catch {
    throw new DarkwebError("INVALID_ONION_V3", "Input is not a valid URL or onion hostname");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DarkwebError("INVALID_ONION_V3", "Only http and https onion URLs are accepted");
  }
  if (url.username || url.password) {
    throw new DarkwebError("INVALID_ONION_V3", "Credentials are not allowed in onion URLs");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new DarkwebError("INVALID_ONION_V3", "Only onion URL ports 80 and 443 are allowed");
  }
  if (url.hash) {
    url.hash = "";
  }

  return { ...validateOnionHostname(url.hostname), url };
}

export function parseOnionInput(input: string): ValidatedOnion {
  return validateOnionUrl(input.trim(), { allowBareHostname: true });
}

export function assertRecord(value: unknown, source: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `${source} returned a non-object record`);
  }
}

export function requiredString(record: Record<string, unknown>, field: string, source: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `${source} field ${field} is not a string`);
  }
  return value;
}

export function nullableString(record: Record<string, unknown>, field: string, source: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `${source} field ${field} is not a string or null`);
  }
  return value;
}

export function stringArray(record: Record<string, unknown>, field: string, source: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `${source} field ${field} is not a string array`);
  }
  return value;
}

export async function readBoundedResponse(response: Response, maxBytes = SOURCE_MAX_BYTES): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DarkwebError("RESPONSE_TOO_LARGE", `Upstream response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchSource(
  url: URL | string,
  options: { responseType: "json" | "text"; allowNotFound?: boolean; maxBytes?: number },
): Promise<{ data: unknown; status: number; fetchedAt: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: { Accept: options.responseType === "json" ? "application/json" : "text/plain" },
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new DarkwebError("FETCH_TIMEOUT", `Source request exceeded ${SOURCE_TIMEOUT_MS} ms`);
    }
    throw new DarkwebError("SOURCE_UNAVAILABLE", `Source request failed: ${String(error)}`);
  }
  clearTimeout(timer);

  if (!response.ok && !(options.allowNotFound && response.status === 404)) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", `Source returned HTTP ${response.status}`, {
      status: response.status,
    });
  }

  const body = await readBoundedResponse(response, options.maxBytes);
  if (options.responseType === "text") {
    return { data: body.toString("utf8"), status: response.status, fetchedAt: new Date().toISOString() };
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", `Expected JSON but received ${contentType || "no content type"}`);
  }
  try {
    return { data: JSON.parse(body.toString("utf8")), status: response.status, fetchedAt: new Date().toISOString() };
  } catch {
    throw new DarkwebError("UPSTREAM_SCHEMA_CHANGED", "Source returned invalid JSON");
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function boundedLimit(value: number | undefined, defaultValue: number): number {
  const limit = value ?? defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new DarkwebError("SOURCE_UNAVAILABLE", `limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return limit;
}
