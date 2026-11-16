// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WebSessionSigninPage from "@/app/(dashboard)/dashboard/providers/web-session-signin/page";
import { WEB_SESSION_SIGNIN_MESSAGE } from "@/lib/providers/webSessionSigninMessage";

// The sign-in tab: it starts the sign-in on the OmniRoute host, shows the
// streamed view when the host has no display (or the dashboard is on another
// machine), forwards the operator's clicks and keystrokes, and hands the
// captured session back to the dashboard tab.

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The page asks next-intl for its copy — a tiny stand-in keeps the test
// independent from the message catalog.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    let text = key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  },
}));

/** A minimal EventSource stand-in that lets the test push events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

describe("the web-session sign-in tab", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeEventSource.instances = [];
    postMessage = vi.fn();
    Object.defineProperty(window, "opener", {
      value: { postMessage, closed: false },
      writable: true,
      configurable: true,
    });
    window.history.replaceState(
      {},
      "",
      "/dashboard/providers/web-session-signin?provider=claude-web&name=Claude&mode=add"
    );
  });

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

  /** The sign-in starts on the host; the host answers with a streamed session. */
  function streamedFetch() {
    return vi.fn(async (url: string) => {
      if (url === "/api/providers/web-session-login") {
        return Response.json({ success: true, mode: "stream", sessionId: "session-123" });
      }
      if (url === "/api/providers/web-session-login/stream/input") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    });
  }

  async function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<WebSessionSigninPage />);
    });
    // Let the sign-in request settle.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("starts the sign-in and follows the streamed view", async () => {
    vi.stubGlobal("fetch", streamedFetch());
    vi.stubGlobal("EventSource", FakeEventSource);

    await render();

    const source = FakeEventSource.instances[0];
    expect(source).toBeTruthy();
    expect(source.url).toContain("sessionId=session-123");

    await act(async () => {
      source.emit("frame", { data: "aGVsbG8=", width: 1280, height: 800 });
    });

    const image = container?.querySelector("img");
    expect(image).toBeTruthy();
    expect(image?.getAttribute("src")).toContain("data:image/jpeg;base64,");
  });

  it("forwards the operator's clicks and keystrokes to the streamed page", async () => {
    const fetchMock = streamedFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);

    await render();

    await act(async () => {
      FakeEventSource.instances[0].emit("frame", { data: "aGVsbG8=", width: 1280, height: 800 });
    });

    const image = container?.querySelector("img") as HTMLImageElement | null;
    expect(image).toBeTruthy();

    // jsdom has no layout — give the frame a size so the click can be mapped
    // onto the streamed page's viewport.
    if (image) {
      image.getBoundingClientRect = () =>
        ({
          width: 640,
          height: 400,
          left: 0,
          top: 0,
          right: 640,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    await act(async () => {
      image?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 }));
    });

    const inputCalls = fetchMock.mock.calls.filter(
      (call) => (call as [string])[0] === "/api/providers/web-session-login/stream/input"
    );
    expect(inputCalls.length).toBeGreaterThan(0);
    const [, init] = inputCalls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.sessionId).toBe("session-123");
    expect(body.event.type).toBe("click");
  });

  it("hands the captured session back to the dashboard tab", async () => {
    vi.stubGlobal("fetch", streamedFetch());
    vi.stubGlobal("EventSource", FakeEventSource);

    await render();

    await act(async () => {
      FakeEventSource.instances[0].emit("result", {
        success: true,
        credential: "sessionKey=abc",
        providerSpecificData: { cookie: "sessionKey=abc" },
        alreadySignedIn: false,
      });
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload, origin] = postMessage.mock.calls[0] as [
      { type: string; success: boolean; credential?: string },
      string,
    ];
    expect(payload.type).toBe(WEB_SESSION_SIGNIN_MESSAGE);
    expect(payload.success).toBe(true);
    expect(payload.credential).toBe("sessionKey=abc");
    expect(origin).toBe(window.location.origin);
  });

  it("reports a failed sign-in back to the dashboard tab", async () => {
    vi.stubGlobal("fetch", streamedFetch());
    vi.stubGlobal("EventSource", FakeEventSource);

    await render();

    await act(async () => {
      FakeEventSource.instances[0].emit("error", { type: "error", message: "Login timed out" });
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload] = postMessage.mock.calls[0] as [{ success: boolean; error?: string }];
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Login timed out");
  });
});
