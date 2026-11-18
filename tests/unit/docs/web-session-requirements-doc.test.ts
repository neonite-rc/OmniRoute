/**
 * The documented per-site requirements must match the code.
 *
 * The guide tells the operator what each site needs when the session is
 * copied by hand. That table is only useful while it is TRUE, so it is
 * checked against the two files that decide it:
 *
 *   - `open-sse/services/tokenExtractionConfig.ts` — the login URL and the
 *     token sources (cookie / localStorage / sessionStorage / header),
 *   - `src/shared/providers/webSessionCredentials.ts` — the credential kind.
 *
 * A provider added to the configs without a docs entry fails this test, and a
 * documented value that no longer exists fails it too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { TOKEN_EXTRACTION_CONFIGS } = await import(
  "../../../open-sse/services/tokenExtractionConfig.ts"
);

const GUIDE_PATH = path.join(process.cwd(), "docs/guides/WEB_SESSION_BROWSER_SIGNIN.md");

function readGuide(): string {
  return fs.readFileSync(GUIDE_PATH, "utf8");
}

/** The rows of the "The session lives in" table. */
function documentedRows(guide: string): Map<string, string> {
  // Only the requirements table — the guide has other provider tables whose
  // second column means something else.
  const section = guide.split("## What each site requires")[1]?.split("\n## ")[0] ?? "";
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const match = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|(.*)\|\s*$/);
    if (!match) continue;
    const [, provider, rest] = match;
    // Only the requirements table has a second column that names sources.
    if (!/cookie|localStorage|sessionStorage|header/i.test(rest)) continue;
    rows.set(provider, rest);
  }
  return rows;
}

test("every provider with an extraction config is documented", () => {
  const guide = readGuide();
  const documented = documentedRows(guide);

  const missing: string[] = [];
  for (const providerId of TOKEN_EXTRACTION_CONFIGS.keys()) {
    if (!documented.has(providerId)) missing.push(providerId);
  }

  assert.deepEqual(
    missing,
    [],
    `these providers need a row in docs/guides/WEB_SESSION_BROWSER_SIGNIN.md: ${missing.join(", ")}`
  );
});

test("every documented provider still has an extraction config", () => {
  const guide = readGuide();
  const documented = documentedRows(guide);

  const stale: string[] = [];
  for (const providerId of documented.keys()) {
    if (!TOKEN_EXTRACTION_CONFIGS.has(providerId)) stale.push(providerId);
  }

  assert.deepEqual(
    stale,
    [],
    `these providers are documented but no longer have an extraction config: ${stale.join(", ")}`
  );
});

test("the documented sources match the configured token sources", () => {
  const guide = readGuide();
  const documented = documentedRows(guide);

  for (const [providerId, config] of TOKEN_EXTRACTION_CONFIGS) {
    const row = documented.get(providerId);
    assert.ok(row, `${providerId} is missing from the guide`);

    for (const source of config.tokenSources) {
      if (source.type === "cookie") {
        assert.ok(
          row.includes(source.name),
          `${providerId}: the guide does not mention the cookie ${source.name}`
        );
        if (source.domain) {
          assert.ok(
            row.includes(source.domain),
            `${providerId}: the guide does not mention the cookie domain ${source.domain}`
          );
        }
      } else if (source.type === "header") {
        assert.ok(
          row.includes(source.name),
          `${providerId}: the guide does not mention the ${source.name} header`
        );
      } else {
        assert.ok(
          row.includes(source.key),
          `${providerId}: the guide does not mention the ${source.type} key ${source.key}`
        );
      }
    }
  }
});

test("the guide explains that the browser sign-in captures all four source kinds", () => {
  const guide = readGuide();
  for (const kind of ["cookie", "localStorage", "sessionStorage", "header"]) {
    assert.ok(
      guide.includes(kind),
      `the guide must explain the ${kind} capture path`
    );
  }
});
