// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import WebSessionCredentialGuide, {
  type WebSessionCredentialGuideProps,
} from "@/app/(dashboard)/dashboard/providers/[id]/components/WebSessionCredentialGuide";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("WebSessionCredentialGuide cookie acquisition paths", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  it("renders the Cookie Editor fast path alongside the manual developer-tools path", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const t = ((key: string) => key) as WebSessionCredentialGuideProps["t"];
    act(() => {
      root?.render(
        <WebSessionCredentialGuide
          requirement={{ kind: "cookie", credentialName: "session-token" }}
          providerName="Example AI"
          providerWebsite="https://example.ai/login"
          t={t}
        />
      );
    });

    expect(container?.textContent).toContain("Fast path: install the Cookie Editor extension");
    expect(container?.textContent).toContain("Manual path: open the browser developer tools");
    expect(container?.querySelectorAll("ol > li")).toHaveLength(4);

    const providerLink = container?.querySelector('a[href="https://example.ai/login"]');
    expect(providerLink?.getAttribute("target")).toBe("_blank");
    expect(providerLink?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("hides the manual instructions behind a disclosure when browser sign-in is available", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const t = ((key: string) => key) as WebSessionCredentialGuideProps["t"];
    act(() => {
      root?.render(
        <WebSessionCredentialGuide
          requirement={{ kind: "cookie", credentialName: "session-token" }}
          providerName="Example AI"
          providerWebsite="https://example.ai/login"
          t={t}
          collapsible
        />
      );
    });

    // Collapsed: the four-step guide must not dominate the dialog when the
    // one-click browser sign-in is the primary route.
    expect(container?.textContent).not.toContain("Fast path: install the Cookie Editor extension");
    const disclosure = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Manual paste")
    );
    expect(disclosure).toBeTruthy();

    act(() => {
      disclosure?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.textContent).toContain("Fast path: install the Cookie Editor extension");

    const hide = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Hide the manual instructions")
    );
    expect(hide).toBeTruthy();

    act(() => {
      hide?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.textContent).not.toContain("Fast path: install the Cookie Editor extension");
  });
});
