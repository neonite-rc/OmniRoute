// @vitest-environment jsdom
//
// The browser sign-in must be a one-step connect: sign in, and the connection
// is created — no "find the credential field and press Save" step, and no
// dependency on the provider being reachable from the OmniRoute host.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const { default: AddApiKeyModal } = await import(
  "../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/AddApiKeyModal"
);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CAPTURED_CREDENTIAL = "sessionKey=abc; other=def";

function render(props: Record<string, unknown>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root: Root = createRoot(el);
  act(() => {
    root.render(
      <AddApiKeyModal
        isOpen
        provider="claude-web"
        providerName="Claude"
        onSave={async () => undefined}
        onClose={() => {}}
        {...(props as never)}
      />
    );
  });
  return { el, root };
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) ?? null;
}

describe("AddApiKeyModal — browser sign-in auto-connect", () => {
  const containers: Array<{ root: Root; el: HTMLDivElement }> = [];
  let originalFetch: typeof global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    for (const { root, el } of containers) {
      act(() => root.unmount());
      el.remove();
    }
    containers.length = 0;
  });

  it("creates the connection straight after the capture, without a Save click", async () => {
    originalFetch = global.fetch;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/providers/web-session-login") {
        return Response.json({
          success: true,
          credential: CAPTURED_CREDENTIAL,
          providerSpecificData: { cookie: CAPTURED_CREDENTIAL },
          alreadySignedIn: false,
        });
      }
      return Response.json({ valid: true });
    });
    global.fetch = fetchMock as never;

    const onSave = vi.fn(async () => undefined);
    const { el, root } = render({ onSave });
    containers.push({ root, el });

    const button = findButton(el, "Sign in with browser");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0] as {
      apiKey?: string;
      providerSpecificData?: Record<string, unknown>;
    };
    expect(payload.apiKey).toBe(CAPTURED_CREDENTIAL);
    expect(payload.providerSpecificData?.cookie).toBe(CAPTURED_CREDENTIAL);
  });

  it("does not probe the provider before saving a captured session", async () => {
    // The capture came from a live, signed-in browser. A provider that is
    // unreachable from the OmniRoute host must not swallow a good capture.
    originalFetch = global.fetch;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/providers/web-session-login") {
        return Response.json({
          success: true,
          credential: CAPTURED_CREDENTIAL,
          providerSpecificData: { cookie: CAPTURED_CREDENTIAL },
          alreadySignedIn: false,
        });
      }
      return Response.json({ valid: false, error: "fetch failed" });
    });
    global.fetch = fetchMock as never;

    const onSave = vi.fn(async () => undefined);
    const { el, root } = render({ onSave });
    containers.push({ root, el });

    await act(async () => {
      findButton(el, "Sign in with browser")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock.mock.calls.some(([url]) => url === "/api/providers/validate")).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the manual paste path behind a disclosure when browser sign-in is available", () => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => Response.json({})) as never;

    const { el, root } = render({});
    containers.push({ root, el });

    // The one-click path must dominate: the four-step manual instructions are
    // collapsed behind a single row.
    expect(el.textContent).not.toContain("Fast path: install the Cookie Editor extension");
    expect(findButton(el, "Manual paste")).toBeTruthy();
  });
});
