// Browser cookie exports (Firefox/Chrome "Export cookies" JSON) are arrays of cookie
// records, not name→value maps. Pasting one used to collapse into a single garbage pair,
// so gemini-web rejected a perfectly valid session with a cookie-format error.
import test from "node:test";
import assert from "node:assert/strict";

const { normalizeGeminiCookieInput } = await import("../../open-sse/utils/geminiCookies.ts");

test("normalizes a Firefox/Chrome array cookie export", () => {
  const raw = JSON.stringify([
    {
      name: "__Secure-1PSID",
      value: "psid-value",
      domain: ".google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: "__Secure-1PSIDTS",
      value: "psidts-value",
      domain: ".google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ]);

  assert.equal(
    normalizeGeminiCookieInput(raw),
    "__Secure-1PSID=psid-value; __Secure-1PSIDTS=psidts-value"
  );
});

test("normalizes an array nested under a `cookies` key", () => {
  const raw = JSON.stringify({
    cookies: [
      { name: "__Secure-1PSID", value: "psid-json" },
      { name: "__Secure-1PSIDTS", value: "psidts-json" },
    ],
  });

  assert.equal(
    normalizeGeminiCookieInput(raw),
    "__Secure-1PSID=psid-json; __Secure-1PSIDTS=psidts-json"
  );
});

test("drops malformed array records instead of stringifying them", () => {
  const raw = JSON.stringify([
    { name: "__Secure-1PSID", value: "keep-me" },
    { value: "missing-name" },
    { name: "empty-value", value: "" },
    { name: 42, value: "numeric-name" },
    { name: "not-a-string", value: { nested: true } },
    null,
  ]);

  assert.equal(normalizeGeminiCookieInput(raw), "__Secure-1PSID=keep-me");
});

test("keeps supporting the name→value object export", () => {
  const raw = JSON.stringify({
    cookies: { "__Secure-1PSID": "psid-obj", "__Secure-1PSIDTS": "psidts-obj" },
  });

  assert.equal(
    normalizeGeminiCookieInput(raw),
    "__Secure-1PSID=psid-obj; __Secure-1PSIDTS=psidts-obj"
  );
});

test("keeps supporting a plain cookie header and a bare PSID value", () => {
  assert.equal(
    normalizeGeminiCookieInput("__Secure-1PSID=abc; __Secure-1PSIDTS=def"),
    "__Secure-1PSID=abc; __Secure-1PSIDTS=def"
  );
  assert.equal(normalizeGeminiCookieInput("bare-value"), "__Secure-1PSID=bare-value");
  assert.equal(normalizeGeminiCookieInput("   "), "");
});
