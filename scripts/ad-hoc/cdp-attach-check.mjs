/**
 * Live check of the CDP attach path used by the browser sign-in.
 *
 * Starts a real browser with a remote-debugging endpoint, opens a tab in it
 * ("the operator's tab"), then drives it the way runBrowserLogin does:
 *   - attach over CDP
 *   - open a NEW page (never reuse the operator's tab)
 *   - close the page we opened
 *   - disconnect
 *
 * The tab list is read from the browser itself (CDP /json/list), not from a
 * Playwright wrapper that may hold a stale snapshot.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-profile-"));
const CDP_URL = "http://127.0.0.1:9333";

const child = spawn(
  chromium.executablePath(),
  [
    `--remote-debugging-port=9333`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${CDP_URL}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("CDP endpoint never came up");
}

/** Ground truth: the tabs the browser really has open. */
async function browserTabs() {
  const res = await fetch(`${CDP_URL}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === "page").map((t) => t.url);
}

let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  if (!ok) failed = true;
};

try {
  const banner = await waitForCdp();
  console.log(`browser banner: ${banner.Browser}`);

  const tabsBefore = await browserTabs();
  console.log(`tabs before: ${tabsBefore.length}`);

  // The operator's own tab.
  const operatorBrowser = await chromium.connectOverCDP(CDP_URL);
  const operatorContext = operatorBrowser.contexts()[0];
  const operatorTab = await operatorContext.newPage();
  await operatorTab.goto("about:blank");
  const operatorTabsCount = (await browserTabs()).length;

  // --- what runBrowserLogin does ---
  const attached = await chromium.connectOverCDP(CDP_URL);
  const context = attached.contexts()[0];
  const page = await context.newPage();
  await page.goto("about:blank");

  const tabsWithOurs = await browserTabs();
  check("a NEW tab was opened", tabsWithOurs.length === operatorTabsCount + 1);
  check(
    "the operator's tab was not navigated",
    (await operatorTab.url()).startsWith("about:blank")
  );

  // The finally block: close our tab, then disconnect.
  await page.close();
  await attached.close();
  // --- end ---

  await sleep(600);
  const tabsAfter = await browserTabs();
  check(
    `our tab is closed (tabs: ${tabsAfter.length}, expected ${operatorTabsCount})`,
    tabsAfter.length === operatorTabsCount
  );
  check("the operator's tab survived", operatorContext.pages().includes(operatorTab));
  check("the operator's browser survived the disconnect", operatorBrowser.isConnected());

  const stillAlive = await fetch(`${CDP_URL}/json/version`).then((r) => r.ok).catch(() => false);
  check("the browser process is still running (CDP still answers)", stillAlive);

  await operatorBrowser.close();
} catch (err) {
  console.error("ERROR:", err);
  failed = true;
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
