#!/usr/bin/env node
/**
 * Targeted locale propagation for the browser-sign-in UI strings.
 *
 * The canonical tool is `npm run i18n:sync-ui`, but it also back-fills every
 * OTHER key the locales happen to be missing (there is a pre-existing drift of
 * ~48 unrelated keys). For a focused change we only want the keys this change
 * introduced, so this script copies exactly those from en.json into every
 * locale, using the same `__MISSING__:<english>` sentinel the sync tool emits
 * for untranslated values.
 *
 * Vietnamese is special: `tests/unit/i18n-vi-completeness.test.ts` holds it to
 * full completeness (no `__MISSING__` markers at all), so vi gets real
 * translations instead of sentinels.
 *
 * One-shot helper for the web-session auto-capture change; kept under
 * scripts/ad-hoc/ per the repo's file-placement rules.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MESSAGES = path.join(ROOT, "src", "i18n", "messages");

/** Keys introduced by the browser-sign-in change. */
const KEYS = [
  "webSessionBrowserSignInTitle",
  "webSessionBrowserSignInBody",
  "webSessionBrowserSignInButton",
  "webSessionBrowserSignInWaiting",
  "webSessionBrowserSignInFailed",
  "webSessionBrowserSignInEmpty",
  "webSessionResyncTitle",
  "webSessionResyncBody",
  "webSessionResyncButton",
  "webSessionResyncDone",
  "webSessionResyncDoneAlready",
];

/**
 * Real Vietnamese translations — vi.json is held to full completeness by
 * tests/unit/i18n-vi-completeness.test.ts, so it may never carry a
 * `__MISSING__` sentinel.
 */
const VIETNAMESE = {
  webSessionBrowserSignInTitle: "Đăng nhập vào {provider} trong trình duyệt",
  webSessionBrowserSignInBody:
    "Một cửa sổ trình duyệt sẽ mở trên máy này. Hãy đăng nhập vào {provider} tại đó và OmniRoute sẽ tự thu thập phiên cho bạn — không cần sao chép cookie từ DevTools.",
  webSessionBrowserSignInButton: "Đăng nhập bằng trình duyệt",
  webSessionBrowserSignInWaiting: "Đang chờ đăng nhập…",
  webSessionBrowserSignInFailed:
    "Đăng nhập bằng trình duyệt không hoàn tất. Hãy thử lại, hoặc dán thông tin xác thực theo cách thủ công.",
  webSessionBrowserSignInEmpty:
    "Phiên trình duyệt không tạo ra thông tin xác thực. Hãy đăng nhập lại và thử lại.",
  webSessionResyncTitle: "Làm mới phiên {provider} đã lưu",
  webSessionResyncBody:
    "OmniRoute tái sử dụng hồ sơ trình duyệt đã lưu cho {provider}. Nếu phiên vẫn còn hiệu lực thì nó sẽ được làm mới tự động; nếu không, hãy đăng nhập lại trong cửa sổ sẽ mở.",
  webSessionResyncButton: "Đồng bộ lại phiên",
  webSessionResyncDone: "Đã thu thập và lưu phiên.",
  webSessionResyncDoneAlready: "Đã làm mới phiên từ hồ sơ trình duyệt đã lưu.",
};

const en = JSON.parse(await fs.readFile(path.join(MESSAGES, "en.json"), "utf8"));
const english = {};
for (const key of KEYS) {
  if (typeof en.providers?.[key] !== "string") {
    throw new Error(`en.json is missing providers.${key}`);
  }
  english[key] = en.providers[key];
}

const files = (await fs.readdir(MESSAGES)).filter((f) => f.endsWith(".json"));
let changed = 0;

for (const file of files) {
  if (file === "en.json") continue;
  const full = path.join(MESSAGES, file);
  const raw = await fs.readFile(full, "utf8");
  const json = JSON.parse(raw);

  const providers = json.providers;
  if (!providers || typeof providers !== "object") {
    console.warn(`skip ${file}: no providers namespace`);
    continue;
  }

  const isVietnamese = file === "vi.json";
  const missing = KEYS.filter((key) => typeof providers[key] !== "string");

  // Insert right after webSessionGuideStep4 so the browser-sign-in strings sit
  // next to the manual guide they complement. Falls back to appending at the
  // end of the namespace when the anchor is absent.
  const rebuilt = {};
  let inserted = false;
  for (const [key, value] of Object.entries(providers)) {
    if (isVietnamese && KEYS.includes(key)) {
      // Overwrite with the real translation — vi may never carry a sentinel.
      rebuilt[key] = VIETNAMESE[key];
      continue;
    }
    if (!isVietnamese && KEYS.includes(key) && typeof providers[key] === "string") {
      // Refresh the sentinel so it always carries the current English text.
      rebuilt[key] = `__MISSING__:${english[key]}`;
      continue;
    }
    rebuilt[key] = value;
    if (key === "webSessionGuideStep4") {
      for (const addKey of missing) {
        rebuilt[addKey] = isVietnamese
          ? VIETNAMESE[addKey]
          : `__MISSING__:${english[addKey]}`;
      }
      inserted = true;
    }
  }
  if (!inserted) {
    for (const addKey of missing) {
      rebuilt[addKey] = isVietnamese ? VIETNAMESE[addKey] : `__MISSING__:${english[addKey]}`;
    }
  }
  json.providers = rebuilt;

  await fs.writeFile(full, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  changed++;
  console.log(`${file}: ${isVietnamese ? "translated" : `+${missing.length}`}`);
}

console.log(`done — ${changed} locale(s) updated`);
