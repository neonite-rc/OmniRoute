/**
 * InAppLoginService — Playwright-based web login for cookie providers
 *
 * Opens a Playwright browser context, navigates to the provider's login page,
 * and polls for target cookies/tokens after the user completes login.
 *
 * Used as the dashboard/web fallback path when Electron is not available.
 * For Electron-native login, see electron/loginManager.js.
 *
 * Events:
 *   "status" — { providerId: string, status: string, message: string }
 *     status values: starting, navigating, waiting, polling, complete, error, cancelled
 */

import { EventEmitter } from "events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  TOKEN_EXTRACTION_CONFIGS,
  TokenExtractionConfig,
  type TokenSource,
} from "./tokenExtractionConfig";
import { matchesCookieDomain } from "../utils/cookieDomain";
import { resolveDataDir } from "@/lib/dataPaths";
import {
  resolveBrowserForFamily,
  resolvePreferredSystemBrowser,
  type BrowserEngine,
  type ChromiumChannel,
} from "./systemBrowser";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LoginResult {
  success: boolean;
  credentials?: Record<string, string>;
  /**
   * Every cookie observed in the provider's domain during the session — the
   * full browser jar, not just the provider's declared token sources.
   *
   * Providers routinely need companion cookies they do not declare: grok.com
   * rejects `sso` without `sso-rw` (#3063) and pins `cf_clearance` to the
   * browser that earned it, while LMArena's session lives in the
   * `arena-auth-prod-v1.0` / `.1` chunks. Capturing only the declared names
   * drops those, so the captured session authenticates and is then rejected
   * upstream.
   */
  cookies?: Array<{ name: string; value: string }>;
  /**
   * True when the capture came from a browser profile that was already signed
   * in — the operator did not have to sign in again. The dashboard reports it
   * as a re-sync rather than a fresh sign-in.
   */
  alreadySignedIn?: boolean;
  error?: string;
}

interface ActiveLogin {
  providerId: string;
  aborted: boolean;
}

export function captureConfiguredHeaders(
  tokenSources: readonly TokenSource[],
  requestHeaders: Record<string, string>,
  credentials: Record<string, string>
): void {
  for (const source of tokenSources) {
    if (source.type !== "header" || credentials[source.name]) continue;
    const value = requestHeaders[source.name.toLowerCase()];
    if (typeof value === "string" && value.trim()) {
      credentials[source.name] = value.trim();
    }
  }
}

/**
 * The domain whose cookies belong to this provider.
 *
 * Prefers the provider's explicit `cookieDomain` override (e.g. Gemini's
 * `.google.com`, which spans google.com accounts) and falls back to the
 * hostname of the provider's home URL.
 */
export function resolveProviderCookieDomain(config: TokenExtractionConfig): string {
  if (config.cookieDomain && config.cookieDomain.trim()) return config.cookieDomain.trim();
  try {
    return new URL(config.homeUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Keep only the cookies that belong to the provider's domain.
 *
 * Domain matching is by exact host or dot-boundary suffix (never `includes`):
 * a look-alike host such as `claude.ai.attacker.tld` must never contribute a
 * cookie to the operator's stored credential.
 */
export function filterProviderCookies(
  cookies: ReadonlyArray<{ name: string; value: string; domain?: string }>,
  cookieDomain: string
): Array<{ name: string; value: string }> {
  if (!cookieDomain) return [];
  const kept: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string" || !cookie.name.trim()) continue;
    if (!matchesCookieDomain(cookie.domain, cookieDomain)) continue;
    const name = cookie.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push({ name, value: typeof cookie.value === "string" ? cookie.value : "" });
  }
  return kept;
}

/** Whether the persistent browser profile (the Proxima-style session store) is enabled. */
export function isPersistentProfileEnabled(): boolean {
  const flag = process.env.OMNIROUTE_WEB_SESSION_PROFILE;
  if (flag === undefined) return true;
  return flag !== "off" && flag !== "0" && flag !== "false";
}

/**
 * Directory holding the persistent browser profile for a provider.
 *
 * The profile keeps the operator's live web session between captures, so a
 * re-sync does not require signing in again — the same model as Proxima's
 * per-provider Electron session partition.
 *
 * It lives under the OmniRoute data directory (not the repo) because it holds
 * session cookies, and is created with owner-only permissions.
 */
export function resolveBrowserProfileDir(providerId: string, dataDir: string): string {
  // Dots are dropped as well as separators: the profile directory must be a
  // single, traversal-free path segment under the profile root.
  const safeProviderId = providerId.replace(/[^a-zA-Z0-9_-]/g, "_") || "provider";
  return path.join(dataDir, "browser-profiles", safeProviderId);
}

/**
 * Delete the saved browser profile for a provider.
 *
 * Used when a re-synced session turns out to be expired: the stale profile
 * would keep the "already signed in" fast path happy, so every later capture
 * would store the same dead credential again. Removing it makes the next
 * attempt open a signed-out window.
 *
 * @returns true when a profile directory was removed.
 */
export function clearBrowserProfile(
  providerId: string,
  dataDir: string = resolveDataDir()
): boolean {
  const profileDir = resolveBrowserProfileDir(providerId, dataDir);
  try {
    if (!fs.existsSync(profileDir)) return false;
    fs.rmSync(profileDir, { recursive: true, force: true });
    return true;
  } catch {
    // A locked profile directory is not fatal — the next capture simply falls
    // back to a fresh sign-in.
    return false;
  }
}

/**
 * Turn a browser-launch failure into something the operator can act on.
 *
 * Playwright's raw failure is a multi-kilobyte dump: the browser command line,
 * the launch call log, and a boxed banner. None of that helps the operator,
 * and the single most common cause — no display on the OmniRoute host — is
 * buried in the middle of it.
 */
export function describeBrowserLaunchFailure(err: unknown, browserName?: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/Missing X server|\$DISPLAY|XServer|headless: true/i.test(raw)) {
    return (
      "The OmniRoute host has no display, so the sign-in browser cannot open. " +
      "Run OmniRoute on a desktop machine, or start it with a virtual display " +
      "(for example `xvfb-run npm run dev`), or paste the session credential manually."
    );
  }
  if (/Executable doesn't exist|please run the following command to download new browsers/i.test(raw)) {
    // Name the browser that is actually missing: the operator asked for a
    // specific one, and "install chromium" would be the wrong advice for a
    // Firefox dashboard.
    const install =
      browserName === "firefox"
        ? "npx playwright install firefox"
        : browserName === "webkit"
          ? "npx playwright install webkit"
          : "npx playwright install chromium";
    const label =
      browserName === "firefox"
        ? "Firefox"
        : browserName === "webkit"
          ? "the WebKit build"
          : "Chromium";
    return (
      `${label} is not installed on this host. ` +
      `Run \`${install}\` on the OmniRoute machine, or open the dashboard in a ` +
      `browser this host can run, or paste the session credential manually.`
    );
  }
  if (/EACCES|EPERM|Permission denied/i.test(raw)) {
    return (
      "The OmniRoute host could not start the sign-in browser (permission denied). " +
      "Check the browser cache and data-directory permissions, or paste the session " +
      "credential manually."
    );
  }

  // Unknown failure: keep it short. The full Playwright dump is sanitized and
  // truncated by the route layer, but there is no reason to ship the whole
  // browser command line to the dashboard.
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
  return `Could not open the sign-in browser: ${firstLine.slice(0, 200)}`;
}

// ─── Browser selection ──────────────────────────────────────────────────────

/**
 * How long the host may spend downloading a missing browser build.
 *
 * The build is cached in the Playwright browser cache, so this is a one-time
 * cost per browser family.
 */
const BROWSER_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How the sign-in browser is obtained.
 *
 *  - `attached`: the operator's own browser, already running with a remote
 *    debugging endpoint. This is the best case — it is the browser they are
 *    signed into, so the capture needs no password at all.
 *  - `launched`: a browser we start ourselves, matching the host's default
 *    browser so the window looks like the one the operator uses.
 *  - `bundled`: Playwright's bundled Chromium, the last-resort fallback.
 */
export type BrowserLaunchMode = "attached" | "launched" | "bundled";

export interface BrowserLaunchInfo {
  mode: BrowserLaunchMode;
  /** Name shown in the dashboard, e.g. "Firefox" or "Google Chrome". */
  browserName: string;
  /** True when the operator's already-running browser will be used. */
  usesRunningBrowser: boolean;
  /**
   * True when the browser build is already cached on this host.
   *
   * A missing build is not a problem: the host downloads it on the first
   * sign-in that needs it. The dashboard shows this so nobody expects to
   * install anything themselves.
   */
  browserBuildReady: boolean;
}

/** The browser we would start for the sign-in window. */
export interface BrowserLaunchTarget {
  browserName: "chromium" | "firefox" | "webkit";
  /**
   * The engine of the host's default browser. "unknown" when no default
   * browser could be identified, in which case any attachable browser is
   * acceptable.
   */
  preferredEngine: BrowserEngine;
  channel?: ChromiumChannel;
  executablePath?: string;
  label: string;
}

type PlaywrightModule = typeof import("playwright");

/**
 * The remote-debugging endpoint of a browser that is already running.
 *
 * Chrome's default is `http://127.0.0.1:9222`; Firefox's remote agent uses
 * the same port when asked to. Set `OMNIROUTE_WEB_SESSION_CDP_URL` to point
 * somewhere else, or `OMNIROUTE_WEB_SESSION_CDP=off` to never attach.
 */
function resolveCdpEndpoint(): string | null {
  const flag = process.env.OMNIROUTE_WEB_SESSION_CDP;
  if (flag === "off" || flag === "0" || flag === "false") return null;
  const configured = process.env.OMNIROUTE_WEB_SESSION_CDP_URL?.trim();
  if (configured) return configured;
  return "http://127.0.0.1:9222";
}

/** The engine a CDP endpoint belongs to, from its `/json/version` banner. */
function detectEngineFromCdpBanner(banner: string): BrowserEngine {
  const lower = banner.toLowerCase();
  if (lower.includes("firefox")) return "firefox";
  if (lower.includes("safari") || lower.includes("webkit")) return "webkit";
  if (lower.includes("chrome") || lower.includes("chromium") || lower.includes("edg")) {
    return "chromium";
  }
  return "unknown";
}

/**
 * Probe the remote-debugging endpoint of a browser that is already running.
 *
 * This only performs an HTTP GET — it does not import Playwright — so the
 * dashboard can ask "which browser will open?" cheaply.
 */
async function probeCdpEndpoint(
  preferredEngine: BrowserEngine
): Promise<{ endpoint: string; engine: BrowserEngine } | null> {
  const endpoint = resolveCdpEndpoint();
  if (!endpoint) return null;

  let banner = "";
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { Browser?: unknown };
    banner = typeof payload.Browser === "string" ? payload.Browser : "";
  } catch {
    return null;
  }

  const engine = detectEngineFromCdpBanner(banner);
  if (engine === "unknown") return null;
  // The operator asked for their default browser: quietly attaching a
  // different one would be more confusing than the extra sign-in.
  if (preferredEngine !== "unknown" && engine !== preferredEngine) return null;
  return { endpoint, engine };
}

/**
 * Attach to the operator's own running browser, when one is reachable.
 *
 * This is the "sign in with the browser I am already using" path: the
 * browser holds the operator's real accounts, so the capture completes
 * without them typing a password. It only applies to Chromium-family
 * browsers — Playwright cannot drive a system Firefox, and Safari exposes no
 * automation API.
 */
async function attachToRunningBrowser(
  playwright: PlaywrightModule,
  preferredEngine: BrowserEngine
): Promise<{
  browser: import("playwright").Browser;
  context: import("playwright").BrowserContext;
} | null> {
  const probed = await probeCdpEndpoint(preferredEngine);
  if (!probed) return null;

  try {
    const browser = await playwright.chromium.connectOverCDP(probed.endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      return null;
    }
    return { browser, context };
  } catch {
    return null;
  }
}

/**
 * The browser to start for the sign-in window.
 *
 * The dashboard's hint wins: it knows which browser the operator is looking
 * at right now, so the sign-in happens where they already are — their own
 * Firefox, their own Chrome, their own Edge. Safari itself exposes no
 * automation API, so its engine (WebKit) is used instead.
 *
 * Without a hint the host's default browser is used, so an operator who
 * signs in from a terminal or a script still gets the browser they chose for
 * the machine.
 */
export async function resolveBrowserLaunchTarget(
  hint?: BrowserFamily
): Promise<BrowserLaunchTarget> {
  const requested = hint && hint !== "unknown" ? hint : null;

  if (requested === "firefox") {
    // Playwright drives its own Firefox build, so the system Firefox does
    // not have to be installed.
    return { browserName: "firefox", preferredEngine: "firefox", label: "Firefox" };
  }
  if (requested === "safari") {
    return { browserName: "webkit", preferredEngine: "webkit", label: "Safari (WebKit)" };
  }
  if (requested === "chrome" || requested === "edge") {
    const match = await resolveBrowserForFamily(requested);
    return {
      browserName: "chromium",
      preferredEngine: "chromium",
      channel: match?.channel,
      executablePath: match?.executablePath,
      // Name the browser that will really open: the host's own Chrome or Edge
      // when it is installed, the bundled Chromium otherwise. Claiming
      // "Google Chrome" on a host without Chrome is the kind of small lie
      // that sends the operator looking for the wrong window.
      label: match?.name ?? "Chromium",
    };
  }

  const preferred = await resolvePreferredSystemBrowser();
  const preferredEngine = preferred?.engine ?? "unknown";

  if (preferred?.engine === "firefox") {
    return { browserName: "firefox", preferredEngine, label: "Firefox" };
  }
  if (preferred?.engine === "webkit") {
    return { browserName: "webkit", preferredEngine, label: "Safari (WebKit)" };
  }
  if (preferred?.engine === "chromium") {
    return {
      browserName: "chromium",
      preferredEngine,
      channel: preferred.channel,
      executablePath: preferred.executablePath,
      label: preferred.name,
    };
  }
  return { browserName: "chromium", preferredEngine, label: "Chromium" };
}

/** Start the chosen browser with a persistent profile. */
/**
 * Start a throw-away browser window in the requested family.
 *
 * The family is never swapped: a Firefox dashboard gets a Firefox window, a
 * Chrome dashboard gets Chrome. When the host's own Chrome cannot start, the
 * bundled Chromium takes over — same family, works everywhere.
 */
/**
 * Is the browser build for this engine already cached on this host?
 */
function isBrowserEngineInstalled(
  playwright: PlaywrightModule,
  browserName: "chromium" | "firefox" | "webkit"
): boolean {
  const engine = browserName === "chromium" ? playwright.chromium : playwright[browserName];
  if (!engine) return false;
  try {
    const executablePath = engine.executablePath();
    return Boolean(executablePath) && fs.existsSync(executablePath);
  } catch {
    return false;
  }
}

/**
 * Download the browser build for this engine into the host's Playwright
 * browser cache.
 */
async function installBrowserEngine(
  browserName: "chromium" | "firefox" | "webkit"
): Promise<boolean> {
  const cliPath = resolvePlaywrightCliPath();
  if (!cliPath) return false;

  return new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [cliPath, "install", browserName], {
      stdio: "ignore",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, BROWSER_INSTALL_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Make sure the browser build the sign-in needs is present on this host.
 *
 * The browser build is an OmniRoute-side dependency, not the operator's: the
 * server downloads and caches it (in the Playwright browser cache) the first
 * time a sign-in needs it, so nobody has to install anything by hand.
 *
 * Returns `true` when the engine is ready to launch.
 */
async function ensureBrowserEngineInstalled(
  playwright: PlaywrightModule,
  browserName: "chromium" | "firefox" | "webkit"
): Promise<boolean> {
  if (isBrowserEngineInstalled(playwright, browserName)) return true;
  return installBrowserEngine(browserName);
}

/**
 * The Playwright CLI entry point, used to download a browser build.
 *
 * Resolved from the installed package rather than hard-coded, so a bundled or
 * relocated install still works.
 */
function resolvePlaywrightCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("playwright/package.json");
    const packageDir = path.dirname(packageJson);
    const cliPath = path.join(packageDir, "cli.js");
    return fs.existsSync(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}

export async function launchEphemeralBrowser(
  playwright: PlaywrightModule,
  target: BrowserLaunchTarget
): Promise<import("playwright").Browser> {
  const options: import("playwright").LaunchOptions = {
    headless: false, // User must interact with the login page
  };

  if (target.browserName === "firefox") {
    return playwright.firefox.launch(options);
  }
  if (target.browserName === "webkit") {
    return playwright.webkit.launch(options);
  }

  if (target.channel || target.executablePath) {
    try {
      return await playwright.chromium.launch({
        ...options,
        ...(target.channel ? { channel: target.channel } : {}),
        ...(target.executablePath ? { executablePath: target.executablePath } : {}),
      });
    } catch {
      // The host's own Chrome could not start — the bundled Chromium is the
      // same browser family and is always available.
    }
  }
  return playwright.chromium.launch(options);
}

async function launchPersistentContext(
  playwright: PlaywrightModule,
  target: BrowserLaunchTarget,
  profileDir: string,
  contextOptions: { viewport: { width: number; height: number }; locale: string }
): Promise<import("playwright").BrowserContext> {
  if (target.browserName === "firefox") {
    return playwright.firefox.launchPersistentContext(profileDir, {
      ...contextOptions,
      headless: false,
    });
  }
  if (target.browserName === "webkit") {
    return playwright.webkit.launchPersistentContext(profileDir, {
      ...contextOptions,
      headless: false,
    });
  }

  const options: import("playwright").LaunchPersistentContextOptions = {
    ...contextOptions,
    headless: false,
  };
  if (target.channel) options.channel = target.channel;
  if (target.executablePath) options.executablePath = target.executablePath;
  return playwright.chromium.launchPersistentContext(profileDir, options);
}

/**
 * What the dashboard should tell the operator about the sign-in browser.
 *
 * Reported before a capture starts so the operator knows which window to
 * watch — the whole point of matching the default browser is that they can
 * find it among their own windows.
 */
export async function describeBrowserLaunch(hint?: BrowserFamily): Promise<BrowserLaunchInfo> {
  const target = await resolveBrowserLaunchTarget(hint);
  const probed = await probeCdpEndpoint(target.preferredEngine);
  if (probed) {
    return {
      mode: "attached",
      browserName: target.label,
      usesRunningBrowser: true,
      browserBuildReady: true,
    };
  }
  // Is the browser build cached on this host? The host downloads it on
  // demand, so a missing build is not fatal — but the dashboard says so, so
  // nobody expects to install anything themselves.
  let browserBuildReady = true;
  if (!target.executablePath) {
    try {
      const playwright = (await import("playwright")) as PlaywrightModule;
      browserBuildReady = isBrowserEngineInstalled(playwright, target.browserName);
    } catch {
      // Playwright could not be loaded — assume the sign-in will sort it out.
      browserBuildReady = true;
    }
  }
  return {
    mode: "launched",
    browserName: target.label,
    usesRunningBrowser: false,
    browserBuildReady,
  };
}


// ─── Service ────────────────────────────────────────────────────────────────

export class InAppLoginService extends EventEmitter {
  private activeLogin: ActiveLogin | null = null;

  /**
   * Start a login flow for a web-cookie provider using Playwright.
   * @param providerId - e.g. "claude-web", "perplexity-web"
   * @param options.timeout - Total timeout in ms (default: config value or 300s)
   * @param options.browser - The browser family the operator is using, so the
   *   sign-in window opens in the same browser they are looking at.
   */
  async startLogin(
    providerId: string,
    options?: { timeout?: number; browser?: BrowserFamily }
  ): Promise<LoginResult> {
    const config = TOKEN_EXTRACTION_CONFIGS.get(providerId);
    if (!config) {
      this.emit("status", { providerId, status: "error", message: "No extraction config found" });
      return { success: false, error: `No extraction config for provider: ${providerId}` };
    }

    if (this.activeLogin) {
      this.emit("status", {
        providerId,
        status: "error",
        message: "A login is already in progress",
      });
      return { success: false, error: "A login process is already in progress" };
    }

    this.activeLogin = { providerId, aborted: false };
    this.emit("status", {
      providerId,
      status: "starting",
      message: `Opening ${config.displayName} login...`,
    });

    try {
      const result = await this.runBrowserLogin(config, options?.timeout, options?.browser);
      this.emit("status", {
        providerId,
        status: result.success ? "complete" : "error",
        message: result.success
          ? "Credentials extracted successfully"
          : result.error || "Login failed",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("status", { providerId, status: "error", message });
      return { success: false, error: `Login failed: ${message}` };
    } finally {
      this.activeLogin = null;
    }
  }

  /**
   * Run the actual Playwright browser login flow
   */
  private async runBrowserLogin(
    config: TokenExtractionConfig,
    timeout?: number,
    browserHint?: BrowserFamily
  ): Promise<LoginResult> {
    const pollInterval = config.pollingConfig.pollInterval || 1000;
    const maxTimeout = timeout || config.pollingConfig.timeout || 300_000;
    const minLoginTime = config.pollingConfig.minLoginTime || 5000;
    const providerId = config.providerId;
    // Domain whose cookies belong to this provider — the jar we persist is
    // scoped to it so a third-party cookie is never stored as a credential.
    const cookieDomain = resolveProviderCookieDomain(config);

    // Dynamically import Playwright (it's a heavy dep, only load when needed)
    let playwright: any;
    try {
      playwright = await import("playwright");
    } catch {
      return {
        success: false,
        error: "Playwright is not installed. Use Electron for native login.",
      };
    }

    if (this.activeLogin?.aborted) {
      return { success: false, error: "Login cancelled" };
    }

    // Launch browser
    this.emit("status", { providerId, status: "starting", message: "Launching browser..." });

    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    };

    // Prefer a persistent per-provider browser profile so the operator's web
    // session survives between captures: a re-sync then completes without
    // another manual sign-in (the same model as Proxima's per-provider
    // Electron session partition). Fall back to an ephemeral context when the
    // profile cannot be used.
    let browser: import("playwright").Browser | null = null;
    let context: import("playwright").BrowserContext | null = null;
    // A browser we attached to belongs to the operator — it must survive the
    // capture. Only the tab we opened is closed.
    let attachedToRunningBrowser = false;
    // The tab we opened in the operator's own browser. Closing the CDP
    // connection only detaches — it leaves the tab behind — so it is closed
    // explicitly.
    let openedTab: import("playwright").Page | null = null;

    const target = await resolveBrowserLaunchTarget(browserHint);

    // The browser build is an OmniRoute-side dependency: if the family the
    // operator asked for is not cached on this host yet, the host downloads it
    // itself. Nobody has to install anything by hand.
    const needsBundledBuild =
      target.browserName !== "chromium" || target.executablePath === undefined;
    if (needsBundledBuild && !isBrowserEngineInstalled(playwright, target.browserName)) {
      this.emit("status", {
        providerId,
        status: "starting",
        message:
          `Downloading ${target.label} for the sign-in window ` +
          `(one-time, the host caches it for later sign-ins)…`,
      });
    }
    if (needsBundledBuild) {
      const ready = await ensureBrowserEngineInstalled(playwright, target.browserName);
      if (!ready && target.browserName !== "chromium") {
        const message =
          `Could not download the ${target.label} build for the sign-in window. ` +
          `Check the host's network access and disk space, then try again.`;
        this.emit("status", { providerId, status: "error", message });
        return { success: false, error: message };
      }
    }

    // The operator's own running browser is the best case: it already holds
    // their accounts, so the capture needs no password at all.
    const attached = await attachToRunningBrowser(playwright, target.preferredEngine);
    if (attached) {
      browser = attached.browser;
      context = attached.context;
      attachedToRunningBrowser = true;
      this.emit("status", {
        providerId,
        status: "starting",
        message: `Using your running ${target.label}`,
      });
    }

    if (!context && isPersistentProfileEnabled()) {
      const profileDir = resolveBrowserProfileDir(providerId, resolveDataDir());
      try {
        fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        const persistentContext = await launchPersistentContext(
          playwright,
          target,
          profileDir,
          contextOptions
        );
        context = persistentContext;
      } catch (err) {
        // Opening a DIFFERENT browser family would be more confusing than a
        // clear error: the operator asked for Firefox because that is where
        // their accounts are — a Chromium window would have none of them and
        // look like a bug.
        if (target.browserName !== "chromium") {
          const message = describeBrowserLaunchFailure(err, target.browserName);
          this.emit("status", { providerId, status: "error", message });
          return { success: false, error: message };
        }
        this.emit("status", {
          providerId,
          status: "starting",
          message: "Saved browser session unavailable — opening a fresh sign-in window.",
        });
        context = null;
      }
    }

    try {
      if (!context) {
        let launched: import("playwright").Browser;
        try {
          launched = await launchEphemeralBrowser(playwright, target);
        } catch (err) {
          throw new Error(describeBrowserLaunchFailure(err, target.browserName));
        }
        browser = launched;
        const ephemeralContext: import("playwright").BrowserContext =
          await launched.newContext(contextOptions);
        context = ephemeralContext;
      }
      const activeContext: import("playwright").BrowserContext = context;
      // In the operator's own browser we MUST open a new tab: reusing
      // `pages()[0]` would navigate whatever page they had open to the
      // provider's login page.
      const page = attachedToRunningBrowser
        ? await activeContext.newPage()
        : (activeContext.pages()[0] ?? (await activeContext.newPage()));
      if (attachedToRunningBrowser) openedTab = page;
      const credentials: Record<string, string> = {};

      // Playwright normalizes request header names to lowercase. Capture only
      // explicitly configured credentials and never replace the first token
      // observed after login.
      page.on("request", (request: { allHeaders(): Promise<Record<string, string>> }) => {
        void request
          .allHeaders()
          .then((headers) => captureConfiguredHeaders(config.tokenSources, headers, credentials))
          .catch(() => {
            // Some browser-internal requests do not expose their full headers.
          });
      });

      // Detect a session that the persistent profile already holds. When every
      // declared cookie source is present before the operator touches anything,
      // the capture is a pure re-sync: no sign-in interaction is required and
      // the min-login grace period is skipped.
      const cookieSources = config.tokenSources.filter((source) => source.type === "cookie");
      const onlyCookieSources =
        cookieSources.length > 0 && cookieSources.length === config.tokenSources.length;
      const preexistingCookies = await activeContext.cookies();
      const alreadySignedIn =
        onlyCookieSources &&
        cookieSources.every((source) =>
          preexistingCookies.some(
            (cookie: { name: string; domain?: string }) =>
              cookie.name === source.name &&
              (!source.domain || matchesCookieDomain(cookie.domain, source.domain))
          )
        );

      // Navigate to login URL
      this.emit("status", {
        providerId,
        status: "navigating",
        message: alreadySignedIn
          ? `Reusing the saved ${config.displayName} session`
          : `Loading ${config.loginUrl}`,
      });
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Poll for success URL + token extraction
      const maxPolls = Math.floor(maxTimeout / pollInterval);
      const startTime = Date.now();

      for (let i = 0; i < maxPolls; i++) {
        if (this.activeLogin?.aborted) {
          this.emit("status", {
            providerId,
            status: "cancelled",
            message: "Login cancelled by user",
          });
          return { success: false, error: "Login cancelled" };
        }

        // Emit progress every 30 seconds
        if (i > 0 && i % 30 === 0) {
          this.emit("status", {
            providerId,
            status: "waiting",
            message: `Waiting for login... (${Math.round(i / 60)}m)`,
          });
        }

        // Wait before polling (respect minLoginTime on first iteration).
        // A re-sync of an already-signed-in profile skips the grace period.
        if (!alreadySignedIn && Date.now() - startTime < minLoginTime) {
          await sleep(pollInterval);
          continue;
        }

        // Gather cookies from browser context
        const cookies = await activeContext.cookies();
        const tokenSources = config.tokenSources;
        // The full provider-domain jar, captured alongside the declared token
        // sources so companion cookies survive the capture.
        const providerCookies = filterProviderCookies(cookies, cookieDomain);

        // Check cookie-based sources
        for (const source of tokenSources) {
          if (source.type === "cookie") {
            const domain = source.domain || undefined;
            // Exact host or dot-boundary suffix, never `includes()`: a cookie
            // from `<domain>.attacker.tld` would otherwise be captured and
            // persisted as the operator's credential. Same class CodeQL flagged
            // in volcengineConsoleAutoLogin (#860/#861); this callsite was not
            // flagged because the expected domain is config-supplied.
            const matched = cookies.find(
              (c: any) =>
                c.name === source.name && (!domain || matchesCookieDomain(c.domain, domain))
            );
            if (matched && !credentials[source.name]) {
              credentials[source.name] = matched.value;
            }
          }
        }

        // Check localStorage-based tokens
        for (const source of tokenSources) {
          if (source.type === "localStorage" && !credentials[source.key]) {
            try {
              const value = await page.evaluate(
                (key: string) => localStorage.getItem(key),
                source.key
              );
              if (value && typeof value === "string") {
                credentials[source.key] = value;
              }
            } catch {
              // localStorage access may fail on some domains
            }
          }
          if (source.type === "sessionStorage" && !credentials[source.key]) {
            try {
              const value = await page.evaluate(
                (key: string) => sessionStorage.getItem(key),
                source.key
              );
              if (value && typeof value === "string") {
                credentials[source.key] = value;
              }
            } catch {
              // sessionStorage access may fail on some domains
            }
          }
        }

        // Check if all required tokens are found
        const requiredKeys = tokenSources.map((s) =>
          s.type === "cookie"
            ? s.name
            : s.type === "localStorage" || s.type === "sessionStorage"
              ? s.key
              : s.name
        );
        const allFound = requiredKeys.every((k) => credentials[k] !== undefined);

        if (allFound && Object.keys(credentials).length > 0) {
          return { success: true, credentials, cookies: providerCookies, alreadySignedIn };
        }

        // Check for success URL pattern
        if (config.successUrlPattern) {
          try {
            const currentUrl = page.url();
            if (config.successUrlPattern.test(currentUrl) && Object.keys(credentials).length > 0) {
              return { success: true, credentials, cookies: providerCookies, alreadySignedIn };
            }
          } catch {
            // URL access may fail on some pages
          }
        }

        await sleep(pollInterval);
      }

      return { success: false, error: "Login timed out" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("status", { providerId, status: "error", message });
      return { success: false, error: `Login failed: ${message}` };
    } finally {
      if (attachedToRunningBrowser) {
        // The operator's browser belongs to them. Closing the context would
        // take their whole session with it; closing the CDP connection only
        // detaches — so the tab we opened is closed explicitly and their own
        // windows and tabs are left alone.
        if (openedTab) {
          await openedTab.close().catch(() => {});
        }
        if (browser) {
          await browser.close().catch(() => {});
        }
      } else {
        // A persistent context owns its browser — closing the context also
        // flushes the profile back to disk. An ephemeral one needs the browser
        // closed separately.
        if (context) {
          await context.close().catch(() => {});
        }
        if (browser) {
          await browser.close().catch(() => {});
        }
      }
    }
  }

  /**
   * Cancel the current login flow
   */
  cancel(): void {
    if (this.activeLogin) {
      this.emit("status", {
        providerId: this.activeLogin.providerId,
        status: "cancelled",
        message: "Login cancelled by user",
      });
      this.activeLogin.aborted = true;
      this.activeLogin = null;
    }
  }

  /**
   * Get the active provider ID, if any
   */
  getActiveProvider(): string | null {
    return this.activeLogin?.providerId || null;
  }

  /**
   * Check if a login flow is in progress
   */
  isActive(): boolean {
    return this.activeLogin !== null && !this.activeLogin.aborted;
  }
}

// ─── Sleep helper ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const inAppLoginService = new InAppLoginService();
