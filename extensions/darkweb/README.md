# Dark-web research tools

A first-party Pi extension for defensive, read-only dark-web research. It keeps clearnet discovery, structured threat-intelligence feeds, and direct Tor retrieval separate.

The extension registers exactly seven tools, but **all seven begin every session inactive**. Only the user can activate them with the `/darkweb` command; there is no model-callable loader and no injected system-prompt guidance.

## Activation

```text
/darkweb status
/darkweb on onion_lookup
/darkweb on all
/darkweb off onion_fetch
/darkweb off all
```

Activation is session-local. Existing built-in tools and tools from other extensions are preserved. Command argument completion covers actions, `all`, and every registered tool.

## Tools

| Tool | Network path | Purpose |
|---|---|---|
| `onion_search` | Clearnet only | Searches the curated Real-World Onion Sites list and returns source/proof/check evidence without visiting results. Ahmia requests fail explicitly while its browser-dependent anti-automation flow cannot be queried reliably. |
| `onion_lookup` | Clearnet only | Validates the complete v3 address, including version and SHA3 checksum, then queries CIRCL AIL Onion-Lookup. |
| `securedrop_search` | Clearnet only | Searches Freedom of the Press Foundation's official SecureDrop directory API and scan metadata. |
| `ransomware_search` | Clearnet only | Normalizes ransomware.live and RansomLook actor-claim feeds. It never visits claim/leak URLs and labels claims as unverified. |
| `onion_fetch` | Tor only | Performs one constrained GET through a fixed loopback SOCKS endpoint, returning sanitized static text. |
| `tor_status` | Tor only | Proves the proxy can reach an official Tor Project onion; a listening port alone is not reported as healthy. |
| `breach_search` | Clearnet only | Checks whether a password appears in known breach corpora via HIBP k-anonymity (only a 5-character SHA-1 prefix is transmitted; no API key) and looks up which breaches an email address appears in (requires `HIBP_API_KEY`). |

`breach_search` was added to the declarative registry in `index.ts` by a second agent without changing the activation logic; further tools follow the same pattern.

## Direct-fetch policy

`onion_fetch` deliberately does less than a browser:

- accepts only checksum-valid v3 `http`/`https` onion URLs on ports 80 or 443;
- rejects credentials, v2 addresses, onion subdomains, parser ambiguities, and clearnet redirects;
- uses `socks5h` so hostname resolution happens through Tor;
- supplies random SOCKS credentials per tool call, which works with Tor's `IsolateSOCKSAuth` setting to isolate circuits;
- allows at most three redirects, revalidating every destination;
- sends only `GET`, fixed headers, and no cookies, custom headers, request body, forms, uploads, or authentication;
- loads no scripts, subresources, frames, stylesheets, or linked pages;
- allows only `text/html`, `text/plain`, and `application/json` with UTF-8/ASCII;
- enforces caller-bounded compressed and decompressed limits (64 KiB–1 MiB) and a 5–30 second overall timeout;
- strips active/interactive HTML, returns normalized text and at most 50 same-onion links, and never returns raw HTML;
- writes a synchronous JSONL audit record before returning. Audit targets are SHA-256 hashes rather than plaintext URLs.

Fetched text, titles, links, feed records, and metadata are **untrusted evidence**. They are not instructions and do not establish identity, ownership, legality, safety, attribution, or current availability.

This static fetcher is not a substitute for Tor Browser's fingerprinting defenses. Use stock Tor Browser at Safest for interactive access or source submissions. Never use the normal logged-in Brave profile through Tor.

## Configuration

Resolution order:

1. `MYAGENT_TOR_SOCKS_URL`, when explicitly set;
2. `socks5h://127.0.0.1:$MYRIG_SERVICE_TOR_PORT`, rendered from myrig's service registry;
3. `socks5h://127.0.0.1:19050` outside a myrig-managed shell.

The audit path defaults to `~/.local/state/myagent/darkweb/audit.jsonl`; `MYAGENT_DARKWEB_AUDIT_LOG` may override it with an absolute path. The proxy override must remain a `socks5h` URL with an explicit loopback port. Audit directories/files are created with modes `0700`/`0600`, and an existing audit file is forced to `0600` before each append.

`breach_search` password checks use the free unauthenticated Pwned Passwords range API and need no configuration. Account (email) search additionally requires the `HIBP_API_KEY` environment variable (a paid Have I Been Pwned subscription; fetch on demand from 1Password, e.g. `secret env HIBP_API_KEY`). Without it, account searches fail loudly with `API_KEY_MISSING`.

Tor itself is installed and supervised by myrig's `tor` target. The managed configuration binds only the port in `config.toml`'s `[services.tor]` block (currently 19050) and enables `IsolateSOCKSAuth`.

## Stable errors

`TOR_UNAVAILABLE`, `INVALID_ONION_V3`, `REDIRECT_BLOCKED`, `CONTENT_TYPE_BLOCKED`, `RESPONSE_TOO_LARGE`, `FETCH_TIMEOUT`, `UPSTREAM_SCHEMA_CHANGED`, `SOURCE_UNAVAILABLE`, `API_KEY_MISSING`, and `AUDIT_WRITE_FAILED`.

The tools never retry over clearnet, silently substitute a mirror, relax a limit, or convert upstream schema drift into an empty result.

## Development

```sh
cd extensions/darkweb
npm install
npm test
npm run typecheck
```

The regression suite covers checksum validation, malformed/v2/subdomain/userinfo/port rejection, registration and user-only activation, Ahmia's explicit failure, live-schema fixtures, HTML sanitization, same-onion link filtering, clearnet redirect rejection, blocked MIME types, decompression limits, audit redaction, and hard timeouts using a local fake SOCKS server. It makes no onion requests.
