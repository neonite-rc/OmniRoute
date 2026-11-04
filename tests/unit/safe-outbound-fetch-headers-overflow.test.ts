// A provider that answers with more than Node's default 16 KB of response headers makes the
// native fetch throw `TypeError: fetch failed` (cause: UND_ERR_HEADERS_OVERFLOW). OmniRoute used
// to surface that verbatim as `{ valid: false, error: "fetch failed" }`, which reads like a bad
// credential. gemini.google.com/app is a real example: ~26 KB of headers on every request.
import test from "node:test";
import assert from "node:assert/strict";

const { SafeOutboundFetchError, safeOutboundFetch, __setHeadersBudgetFetchForTest } =
  await import("../../src/shared/network/safeOutboundFetch.ts");

const originalFetch = globalThis.fetch;

function headersOverflowError() {
  const cause = Object.assign(new Error("Headers Overflow Error"), {
    code: "UND_ERR_HEADERS_OVERFLOW",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  __setHeadersBudgetFetchForTest(null);
});

test("classifies a headers overflow as HEADERS_OVERFLOW instead of a bare 'fetch failed'", async () => {
  globalThis.fetch = async () => {
    throw headersOverflowError();
  };
  // Keep the test offline: the fallback fetch is stubbed to fail too, so the error propagates.
  __setHeadersBudgetFetchForTest(async () => {
    throw headersOverflowError();
  });

  await assert.rejects(
    safeOutboundFetch("https://gemini.google.com/app", { retry: false }),
    (error: unknown) => {
      assert.equal(error instanceof SafeOutboundFetchError, true);
      const typed = error as { code?: string; message?: string };
      assert.equal(typed.code, "HEADERS_OVERFLOW");
      assert.match(typed.message ?? "", /response headers/i);
      assert.match(typed.message ?? "", /max-http-header-size/);
      assert.doesNotMatch(typed.message ?? "", /^fetch failed$/i);
      return true;
    }
  );
});

test("retries the probe with a larger header budget when the runtime limit is hit", async () => {
  globalThis.fetch = async () => {
    throw headersOverflowError();
  };

  const seen: string[] = [];
  __setHeadersBudgetFetchForTest(async (input) => {
    seen.push(String(input));
    return Response.json({ ok: true });
  });

  const response = await safeOutboundFetch("https://gemini.google.com/app", {
    retry: false,
    timeoutMs: 1000,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen, ["https://gemini.google.com/app"]);
});

test("does not widen the header budget when a proxy is configured", async () => {
  globalThis.fetch = async () => {
    throw headersOverflowError();
  };

  let fallbackCalls = 0;
  __setHeadersBudgetFetchForTest(async () => {
    fallbackCalls += 1;
    return Response.json({ ok: true });
  });

  await assert.rejects(
    safeOutboundFetch("https://gemini.google.com/app", {
      retry: false,
      proxyConfig: { url: "http://proxy.internal:3128" },
      guard: "none",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "HEADERS_OVERFLOW");
      return true;
    }
  );
  assert.equal(fallbackCalls, 0);
});
