/**
 * System browser detection.
 *
 * The browser sign-in flow should open the browser the operator actually uses
 * instead of always opening Playwright's bundled Chromium. Two reasons:
 *
 *  1. Some providers only accept a login flow that looks like the browser the
 *     operator trusts (Google's "confirm it's you" interstitial, Cloudflare's
 *     turnstile, SSO pages that check the user agent).
 *  2. The operator's real browser already has their accounts signed in, so the
 *     sign-in is a click instead of a password hunt.
 *
 * What can and cannot be done differs per browser, so this module only
 * REPORTS what is on the host. The launch decision lives in
 * `inAppLoginService`:
 *
 *  - Chromium family (Chrome / Edge / Brave / Chromium / Vivaldi / Opera):
 *    launched through Playwright with the real executable, so the window is
 *    the operator's own browser.
 *  - Firefox: launched through Playwright's Firefox build. The system Firefox
 *    cannot be driven by Playwright (it needs Firefox's patched juggler build),
 *    so the sign-in runs in a dedicated persistent profile.
 *  - Safari: Safari itself exposes no automation API, so its engine (WebKit)
 *    is used instead.
 *
 * Detection is best-effort: every failure resolves to "unknown" and the
 * caller falls back to the bundled Chromium. Nothing here throws.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

export type BrowserEngine = "chromium" | "firefox" | "webkit" | "unknown";

/** Playwright channels for the Chromium builds Playwright knows how to start. */
export type ChromiumChannel =
  | "chrome"
  | "chrome-beta"
  | "msedge"
  | "msedge-beta"
  | "brave"
  | "chromium";

export interface SystemBrowserInfo {
  /** Stable slug, used for profile names and UI keys. */
  id: string;
  /** Human-readable name shown in the dashboard. */
  name: string;
  engine: BrowserEngine;
  /** Playwright channel, for the Chromium builds Playwright knows. */
  channel?: ChromiumChannel;
  /** Absolute path to the executable, when one was found on disk. */
  executablePath?: string;
  /** True when this browser is the host's default https handler. */
  isDefault: boolean;
}

/** How long a detection helper may run before it is abandoned. */
const DETECT_TIMEOUT_MS = 2500;

/**
 * Known browsers, keyed by the tokens that identify them across Linux
 * desktop entries, macOS bundle identifiers and Windows ProgIds.
 */
interface KnownBrowser {
  id: string;
  name: string;
  engine: BrowserEngine;
  channel?: ChromiumChannel;
  /** Tokens that identify this browser in a desktop id / bundle id / ProgId. */
  tokens: string[];
}

const KNOWN_BROWSERS: KnownBrowser[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    engine: "chromium",
    channel: "chrome",
    tokens: ["google-chrome", "googlechrome", "com.google.chrome", "chromehtml"],
  },
  {
    id: "chrome-beta",
    name: "Google Chrome Beta",
    engine: "chromium",
    channel: "chrome-beta",
    tokens: ["google-chrome-beta", "com.google.chrome.beta"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    engine: "chromium",
    channel: "msedge",
    tokens: ["microsoft-edge", "microsoftedge", "com.microsoft.edgemac", "msedgehtm"],
  },
  {
    id: "brave",
    name: "Brave",
    engine: "chromium",
    channel: "brave",
    tokens: ["brave-browser", "bravebrowser", "com.brave.browser"],
  },
  {
    id: "chromium",
    name: "Chromium",
    engine: "chromium",
    channel: "chromium",
    tokens: ["chromium-browser", "chromium_chromium", "org.chromium.chromium"],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    engine: "chromium",
    tokens: ["vivaldi", "com.vivaldi.vivaldi"],
  },
  {
    id: "opera",
    name: "Opera",
    engine: "chromium",
    tokens: ["opera", "com.operasoftware.opera"],
  },
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    tokens: ["firefox", "org.mozilla.firefox", "firefoxurl"],
  },
  {
    id: "safari",
    name: "Safari",
    engine: "webkit",
    tokens: ["safari", "com.apple.safari"],
  },
];

/** Executable names probed on PATH, per browser id. */
const PATH_EXECUTABLES: Record<string, string[]> = {
  chrome: ["google-chrome-stable", "google-chrome"],
  "chrome-beta": ["google-chrome-beta"],
  edge: ["microsoft-edge-stable", "microsoft-edge"],
  brave: ["brave-browser-stable", "brave-browser"],
  chromium: ["chromium-browser", "chromium"],
  vivaldi: ["vivaldi-stable", "vivaldi"],
  opera: ["opera"],
  firefox: ["firefox"],
};

/** Absolute install locations that are not on PATH. */
function absoluteExecutableCandidates(id: string): string[] {
  const home = os.homedir();
  switch (id) {
    case "chrome":
      return [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome-stable",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
    case "edge":
      return [
        "/opt/microsoft/msedge/msedge",
        "/usr/bin/microsoft-edge",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ];
    case "brave":
      return [
        "/usr/bin/brave-browser",
        "/opt/brave.com/brave/brave-browser",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        path.join(home, "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
      ];
    case "chromium":
      return [
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
    case "vivaldi":
      return [
        "/usr/bin/vivaldi-stable",
        "/opt/vivaldi/vivaldi",
        "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
      ];
    case "opera":
      return [
        "/usr/bin/opera",
        "/opt/opera/opera",
        "/Applications/Opera.app/Contents/MacOS/Opera",
      ];
    case "firefox":
      return [
        "/usr/bin/firefox",
        "/usr/local/bin/firefox",
        "/snap/bin/firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        path.join(home, "Applications/Firefox.app/Contents/MacOS/firefox"),
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      ];
    default:
      return [];
  }
}

/**
 * Run a helper command and return its stdout. Never throws — a missing
 * helper, a non-zero exit or a timeout all resolve to `null`.
 */
function runCommand(command: string, args: string[]): string | null {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: DETECT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(typeof stdout === "string" ? stdout : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** Find an executable on PATH without spawning a shell. */
function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH || "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];

  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable PATH entry — keep scanning.
      }
    }
  }
  return null;
}

/** Resolve the absolute path of a known browser's executable, if installed. */
function findExecutable(id: string): string | null {
  for (const name of PATH_EXECUTABLES[id] || []) {
    const found = findOnPath(name);
    if (found) return found;
  }
  for (const candidate of absoluteExecutableCandidates(id)) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not readable — keep looking.
    }
  }
  return null;
}

/** Classify a raw identifier (desktop id, bundle id, ProgId, app name). */
function classify(rawId: string): KnownBrowser | null {
  const normalized = rawId.toLowerCase().replace(/[^a-z0-9.]/g, "");
  if (!normalized) return null;
  for (const browser of KNOWN_BROWSERS) {
    for (const token of browser.tokens) {
      if (normalized.includes(token.toLowerCase().replace(/[^a-z0-9.]/g, ""))) return browser;
    }
  }
  return null;
}

/**
 * The Linux default handler, as a desktop entry id (`firefox_firefox.desktop`).
 */
async function detectLinuxDefaultId(): Promise<string | null> {
  const output = await runCommand("xdg-settings", ["get", "default-browser"]);
  const desktopId = output?.trim();
  return desktopId && desktopId.length > 0 && !desktopId.includes(" ") ? desktopId : null;
}

/**
 * The macOS default https handler, as a bundle identifier
 * (`com.google.chrome`).
 */
async function detectMacDefaultId(): Promise<string | null> {
  const output = await runCommand("defaults", [
    "read",
    "com.apple.LaunchServices/com.apple.launchservices.secure",
  ]);
  if (!output) return null;
  const schemeMatch = output.match(/"LSHandlerURLScheme\s*=\s*https;"\s*=\s*"([^"]+)"/i);
  if (schemeMatch?.[1]) return schemeMatch[1];
  // Older macOS records only a role per content type; take the html role.
  const roleMatch = output.match(/LSHandlerRoleAll\s*=\s*"(com\.[^"]+)"/i);
  return roleMatch?.[1] || null;
}

/**
 * The Windows default https handler, as a ProgId (`ChromeHTML`).
 */
async function detectWindowsDefaultId(): Promise<string | null> {
  const output = await runCommand("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "/v",
    "ProgId",
  ]);
  const match = output?.match(/ProgId\s+REG_SZ\s+(\S+)/i);
  return match?.[1] || null;
}

/** The host's default https handler, if it can be identified. */
async function detectDefaultBrowserId(): Promise<string | null> {
  try {
    if (process.platform === "linux") return await detectLinuxDefaultId();
    if (process.platform === "darwin") return await detectMacDefaultId();
    if (process.platform === "win32") return await detectWindowsDefaultId();
  } catch {
    // Detection is best-effort.
  }
  return null;
}

/**
 * Every known browser installed on the host, with the default one flagged.
 *
 * The list is built from what is on disk, so a host with no browser at all
 * yields an empty array and the caller falls back to Playwright's bundled
 * Chromium.
 */
export async function detectSystemBrowsers(): Promise<SystemBrowserInfo[]> {
  const defaultId = await detectDefaultBrowserId();
  const defaultBrowser = defaultId ? classify(defaultId) : null;

  const found: SystemBrowserInfo[] = [];
  for (const known of KNOWN_BROWSERS) {
    // Safari ships with macOS but has no executable we can drive; it is
    // reported so the UI can explain the WebKit substitution.
    if (known.id === "safari") {
      if (process.platform === "darwin") {
        found.push({
          id: known.id,
          name: known.name,
          engine: known.engine,
          isDefault: defaultBrowser?.id === known.id,
        });
      }
      continue;
    }

    const executablePath = findExecutable(known.id);
    if (!executablePath) continue;
    found.push({
      id: known.id,
      name: known.name,
      engine: known.engine,
      channel: known.channel,
      executablePath,
      isDefault: defaultBrowser?.id === known.id,
    });
  }

  // The default handler may be a browser we could not find on disk (a snap
  // or flatpak install, a browser in a non-standard location). Report it
  // anyway so the UI can name it.
  if (defaultBrowser && !found.some((browser) => browser.id === defaultBrowser.id)) {
    found.push({
      id: defaultBrowser.id,
      name: defaultBrowser.name,
      engine: defaultBrowser.engine,
      channel: defaultBrowser.channel,
      isDefault: true,
    });
  }

  return found;
}

/**
 * The browser the sign-in window should use: the host's default handler when
 * it can be driven, otherwise the first Chromium-family browser found.
 *
 * Returns `null` when nothing usable is installed — the caller then falls
 * back to Playwright's bundled Chromium.
 */
export async function resolvePreferredSystemBrowser(): Promise<SystemBrowserInfo | null> {
  const browsers = await detectSystemBrowsers();
  const preferred = browsers.find((browser) => browser.isDefault);
  if (preferred) return preferred;
  return browsers.find((browser) => browser.engine === "chromium") || null;
}

/**
 * The installed browser that matches a family the operator asked for.
 *
 * "chrome" accepts any Chromium-family browser: the operator asked for a
 * Chromium, not for a specific brand, so Brave or Vivaldi is a fine answer.
 */
export async function resolveBrowserForFamily(
  family: BrowserFamily
): Promise<SystemBrowserInfo | null> {
  if (family === "unknown") return null;
  const browsers = await detectSystemBrowsers();

  if (family === "firefox") {
    return browsers.find((browser) => browser.id === "firefox") || null;
  }
  if (family === "edge") {
    return browsers.find((browser) => browser.id === "edge") || null;
  }
  if (family === "safari") {
    return browsers.find((browser) => browser.engine === "webkit") || null;
  }
  return browsers.find((browser) => browser.engine === "chromium") || null;
}
