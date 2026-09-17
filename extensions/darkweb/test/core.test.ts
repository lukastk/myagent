import assert from "node:assert/strict";
import test from "node:test";
import { DarkwebError, parseOnionInput, validateOnionHostname, validateOnionUrl } from "../lib/core.ts";
import { parseRwos } from "../lib/sources.ts";

const TOR_PROJECT = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion";

test("validates and canonicalizes a checksum-valid v3 onion", () => {
  assert.equal(validateOnionHostname(TOR_PROJECT.toUpperCase()).hostname, TOR_PROJECT);
  assert.equal(parseOnionInput(TOR_PROJECT).hostname, TOR_PROJECT);
  assert.equal(validateOnionUrl(`https://${TOR_PROJECT}/path#fragment`).url.toString(), `https://${TOR_PROJECT}/path`);
});

test("rejects malformed, legacy, subdomain, credential, port, and checksum-invalid inputs", () => {
  const invalid = [
    "facebookcorewwwi.onion",
    `sub.${TOR_PROJECT}`,
    `http://user:pass@${TOR_PROJECT}/`,
    `http://${TOR_PROJECT}:8080/`,
    `http://${TOR_PROJECT}./`,
    `http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wia.onion/`,
  ];
  for (const input of invalid) {
    assert.throws(() => parseOnionInput(input), (error: unknown) => {
      assert.ok(error instanceof DarkwebError);
      assert.equal(error.code, "INVALID_ONION_V3");
      return true;
    });
  }
});

test("parses curated RWOS records with category, proof, and check evidence", () => {
  const markdown = `
## News And Media

### [Example News](http://${TOR_PROJECT}/)

* plain: \`http://${TOR_PROJECT}/\`
* proof: [link](https://example.org/onion-service)
* check: <span title="attempts=1 code=200 exit=0 time=2026-09-17T10:00:00Z">:heavy_check_mark:</span>
`;
  assert.deepEqual(parseRwos(markdown), [
    {
      title: "Example News",
      category: "News And Media",
      onion_url: `http://${TOR_PROJECT}/`,
      onion_base: TOR_PROJECT,
      proof: { kind: "clearnet_link", url: "https://example.org/onion-service" },
      latest_check: {
        http_code: 200,
        curl_exit: 0,
        time: "2026-09-17T10:00:00Z",
        status: "heavy_check_mark",
      },
      confidence: "curated_with_proof",
    },
  ]);
});
