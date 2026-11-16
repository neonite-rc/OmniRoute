// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import WebSessionBrowserSignIn, {
  type WebSessionBrowserSignInProps,
} from "@/app/(dashboard)/dashboard/providers/[id]/components/WebSessionBrowserSignIn";
import { WEB_SESSION_SIGNIN_MESSAGE } from "@/lib/providers/webSessionSigninMessage";

// The sign-in always happens in a NEW TAB of the browser the dashboard is
// open in — on the operator's own screen, whether the OmniRoute host is that
// same machine or another one on the network. The tab runs the sign-in and
// hands the captured session back to the dashboard tab.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const translator = ((key: string) => key) as WebSessionBrowserSignInProps["t"];

/** The sign-in tab the dashboard opened. */
class FakeTab {
  closed = false;
}

/** The browser-info endpoint: the dashboard is not on the OmniRoute host. */
function remoteDashboardFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/providers/web-session-browser")) {
      return Response.json({
        browserName: "Firefox",
        usesRunningBrowser: false,
        mode: "launched",
        browserBuildReady: true,
        dashboardOnHost: false,
        displayAvailable: true,
        signInMode: "streamed",
      });
    }
    return Response.json({ ok: true, applied: true });
  });
}

/** Post the sign-in tab's answer back to the dashboard tab. */
function postSigninResult(data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: WEB_SESSION_SIGNIN_MESSAGE, ...data },
      origin: window.location.origin,
    })
  );
}

function render(props: Partial<WebSessionBrowserSignInProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <WebSessionBrowserSignIn
        provider="claude-web"
        providerName="Claude"
        mode="add"
        t={translator}
        {...props}
      />
    );
  });

  return { container, root };
}

describe("WebSessionBrowserSignIn — the sign-in opens in a new tab of this browser", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the sign-in page in a new tab", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());
    const tab = new FakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0] as [string, string];
    expect(target).toBe("_blank");
    expect(url).toContain("/dashboard/providers/web-session-signin");
    // The tab knows what to sign in to.
    expect(url).toContain("provider=claude-web");
    expect(url).toContain("name=Claude");
    expect(url).toContain("mode=add");
  });

  it("says where the sign-in appears when the dashboard is on another machine", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("A new tab opens in this browser");
  });

  it("hands the captured session back when the sign-in tab reports it", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());
    vi.spyOn(window, "open").mockReturnValue(new FakeTab() as unknown as Window);

    const onCaptured = vi.fn();
    const rendered = render({ onCaptured });
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      postSigninResult({
        success: true,
        credential: "sessionKey=abc",
        providerSpecificData: { cookie: "sessionKey=abc" },
        alreadySignedIn: false,
      });
    });

    expect(onCaptured).toHaveBeenCalledTimes(1);
    expect(onCaptured.mock.calls[0][0]).toMatchObject({
      credential: "sessionKey=abc",
      alreadySignedIn: false,
    });
  });

  it("reports a failed sign-in from the tab", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());
    vi.spyOn(window, "open").mockReturnValue(new FakeTab() as unknown as Window);

    const onCaptured = vi.fn();
    const rendered = render({ onCaptured });
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      postSigninResult({ success: false, error: "Login timed out" });
    });

    expect(onCaptured).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Login timed out");
  });

  it("re-sync reports to the sync handler instead of the credential form", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());
    vi.spyOn(window, "open").mockReturnValue(new FakeTab() as unknown as Window);

    const onCaptured = vi.fn();
    const onSynced = vi.fn();
    const rendered = render({ mode: "sync", connectionId: "conn-1", onCaptured, onSynced });
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      postSigninResult({ success: true, alreadySignedIn: true });
    });

    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onSynced.mock.calls[0][0]).toMatchObject({ alreadySignedIn: true });
    expect(onCaptured).not.toHaveBeenCalled();
  });

  it("explains that the browser blocked the sign-in tab", async () => {
    vi.stubGlobal("fetch", remoteDashboardFetch());
    vi.spyOn(window, "open").mockReturnValue(null);

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.textContent).toContain("blocked the sign-in tab");
  });
});
