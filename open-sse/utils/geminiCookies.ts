type CookieRecord = Record<string, unknown>;

/** Browser "Export cookies" JSON ships an array of {name, value, domain, ...} records. */
function cookiePairsFromArray(records: unknown[]): string[] {
  return records
    .filter((record): record is CookieRecord => Boolean(record) && typeof record === "object")
    .map((record) => [record.name, record.value] as const)
    .filter(
      ([name, value]) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        typeof value === "string" &&
        value.trim().length > 0
    )
    .map(([name, value]) => `${String(name).trim()}=${String(value).trim()}`);
}

function cookiePairsFromJson(raw: string): string[] {
  if (!raw.startsWith("{") && !raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return cookiePairsFromArray(parsed);

    const container = parsed as CookieRecord;
    const nested = container.cookies;
    if (Array.isArray(nested)) return cookiePairsFromArray(nested);

    const cookies = nested && typeof nested === "object" ? (nested as CookieRecord) : container;
    return Object.entries(cookies)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
      .map(([name, value]) => `${name}=${String(value).trim()}`);
  } catch {
    return [];
  }
}

/** Normalize a pasted Gemini cookie header, bare PSID, or browser-export JSON. */
export function normalizeGeminiCookieInput(raw: string, cookieName = "__Secure-1PSID"): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const jsonPairs = cookiePairsFromJson(trimmed);
  if (jsonPairs.length > 0) return jsonPairs.join("; ");
  return trimmed.includes("=") ? trimmed : `${cookieName}=${trimmed}`;
}
