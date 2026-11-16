// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import WebSessionBrowserSignIn, {
  supportsBrowserSignIn,
  type WebSessionBrowserSignInProps,
} from "@/app/(dashboard)/dashboard/providers/[id]/components/WebSessionBrowserSignIn";
import { WEB_SESSION_SIGNIN_MESSAGE } from "@/lib/providers/webSessionSigninMessage";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const translator = ((key: string) => key) as WebSessionBrowserSignInProps["t"];

/** The sign-in tab the dashboard opened. */
class FakeTab {
  closed = false;
}

/** Let the panel open the sign-in tab (jsdom blocks pop-ups by default). */
function stubTab(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(window, "open").mockReturnValue(new FakeTab() as unknown as Window);
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

describe("supportsBrowserSignIn", () => {
  it("is offered for providers with a token-extraction config", () => {
    expect(supportsBrowserSignIn("claude-web")).toBe(true);
    expect(supportsBrowserSignIn("perplexity-web")).toBe(true);
  });

  it("is hidden for providers without a known login flow", () => {
    expect(supportsBrowserSignIn("openai")).toBe(false);
    expect(supportsBrowserSignIn("notion-web")).toBe(false);
    expect(supportsBrowserSignIn("")).toBe(false);
  });

  it("is hidden for providers whose sign-in has a dedicated flow", () => {
    // Adobe Firefly needs a system-Chrome CDP flow and MaxAI a device-pair
    // flow — the generic browser sign-in must not shadow them.
    expect(supportsBrowserSignIn("adobe-firefly")).toBe(false);
    expect(supportsBrowserSignIn("maxai")).toBe(false);
    expect(supportsBrowserSignIn("conol-web")).toBe(false);
  });

  it("is hidden for a provider that has an extraction config but uses an API key", () => {
    // veoaifree-web is a video provider. It has a token-extraction config, but
    // it authenticates with an API key — capturing a cookie for it would store
    // the wrong credential.
    expect(supportsBrowserSignIn("veoaifree-web")).toBe(false);
    expect(supportsBrowserSignIn("volcengine-console")).toBe(false);
  });
});

describe("WebSessionBrowserSignIn", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalUserAgent = window.navigator.userAgent;

  function setUserAgent(userAgent: string) {
    Object.defineProperty(window.navigator, "userAgent", {
      value: userAgent,
      configurable: true,
    });
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    setUserAgent(originalUserAgent);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders nothing for a provider without a browser sign-in flow", () => {
    const rendered = render({ provider: "openai" });
    container = rendered.container;
    root = rendered.root;

    expect(container?.querySelector("button")).toBeNull();
  });

  it("renders nothing in sync mode when there is no connection to persist onto", () => {
    // Falling back to the capture endpoint would hand the captured credential
    // to nobody — the modal would close without saving it.
    const rendered = render({ mode: "sync", connectionId: undefined });
    container = rendered.container;
    root = rendered.root;

    expect(container?.querySelector("button")).toBeNull();
  });

  it("captures the session and hands the credential back for the add flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }))
    );
    stubTab();

    const onCaptured = vi.fn();
    const rendered = render({ onCaptured });
    container = rendered.container;
    root = rendered.root;

    const button = container?.querySelector("button");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The sign-in tab reports the captured session back to this tab.
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
      providerSpecificData: { cookie: "sessionKey=abc" },
      alreadySignedIn: false,
    });
  });

  it("asks for the operator's own browser so the sign-in window opens in it", async () => {
    // The operator is on Firefox; the window that opens must be Firefox, not
    // the bundled Chromium that has none of their accounts.
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/providers/web-session-browser")) {
        return Response.json({
          browserName: "Firefox",
          usesRunningBrowser: false,
          mode: "launched",
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = stubTab();

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const infoCall = fetchMock.mock.calls.find((call) =>
      String((call as [string])[0]).startsWith("/api/providers/web-session-browser")
    );
    expect(infoCall).toBeTruthy();
    expect(String((infoCall as [string])[0])).toContain("browser=firefox");

    // The sign-in tab knows which provider to sign in to.
    const [url] = open.mock.calls[0] as [string];
    expect(url).toContain("provider=claude-web");
  });

  it("names the browser that will open", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/providers/web-session-browser")) {
        return Response.json({
          browserName: "Firefox",
          usesRunningBrowser: false,
          mode: "launched",
        });
      }
      return Response.json({ success: true, alreadySignedIn: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Firefox");
  });

  it("says when the operator's own running browser is used", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/providers/web-session-browser")) {
        return Response.json({
          browserName: "Google Chrome",
          usesRunningBrowser: true,
          mode: "attached",
        });
      }
      return Response.json({ success: true, alreadySignedIn: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Google Chrome");
    expect(container?.textContent).toContain("already running");
  });

  it("says the host downloads the browser itself — nothing to install locally", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/providers/web-session-browser")) {
        return Response.json({
          browserName: "Firefox",
          usesRunningBrowser: false,
          mode: "launched",
          browserBuildReady: false,
        });
      }
      return Response.json({ success: true, alreadySignedIn: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render();
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Firefox");
    expect(container?.textContent).toContain("nothing to install");
  });

  it("persists onto the connection in sync mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }))
    );
    const open = stubTab();

    const onSynced = vi.fn();
    const rendered = render({ mode: "sync", connectionId: "conn-123", onSynced });
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The sign-in tab re-syncs the given connection.
    const [url] = open.mock.calls[0] as [string];
    expect(url).toContain("mode=sync");
    expect(url).toContain("connectionId=conn-123");

    await act(async () => {
      postSigninResult({ success: true, alreadySignedIn: true });
    });

    expect(onSynced).toHaveBeenCalledWith({ alreadySignedIn: true });
  });

  it("surfaces the server error instead of failing silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }))
    );
    stubTab();

    const onCaptured = vi.fn();
    const rendered = render({ onCaptured });
    container = rendered.container;
    root = rendered.root;

    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      postSigninResult({ success: false, error: "Login timed out" });
    });

    expect(container?.textContent).toContain("Login timed out");
    expect(onCaptured).not.toHaveBeenCalled();
  });
});
