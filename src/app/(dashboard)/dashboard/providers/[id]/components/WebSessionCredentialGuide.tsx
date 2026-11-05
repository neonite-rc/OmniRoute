"use client";

// Issue #3501 Phase 1c — extracted from the god-component.
// Shared by AddApiKeyModal and EditConnectionModal; imports only leaf modules
// (no cycle risk).

import { useState } from "react";
import type { WebSessionCredentialRequirement } from "../webSessionCredentials";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

export interface WebSessionCredentialGuideProps {
  requirement: WebSessionCredentialRequirement;
  providerName: string;
  providerWebsite?: string;
  t: ProviderMessageTranslator;
  /**
   * Hide the manual instructions behind a disclosure, collapsed by default.
   *
   * Used when the one-click browser sign-in is available: copying a cookie
   * out of DevTools is the fallback, not the main route, and a four-step
   * instruction block would otherwise dominate the dialog.
   */
  collapsible?: boolean;
}

export function getProviderWebsiteHost(providerWebsite?: string): string | null {
  if (!providerWebsite) {
    return null;
  }

  try {
    return new URL(providerWebsite).host;
  } catch {
    return providerWebsite;
  }
}

export default function WebSessionCredentialGuide({
  requirement,
  providerName,
  providerWebsite,
  t,
  collapsible = false,
}: WebSessionCredentialGuideProps) {
  const providerWebsiteHost = getProviderWebsiteHost(providerWebsite);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = !collapsible || manuallyExpanded;

  // Collapsed: a single row that says how to open the manual instructions.
  if (collapsible && !expanded && requirement.kind !== "none") {
    return (
      <button
        type="button"
        onClick={() => setManuallyExpanded(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-purple-500/25 bg-purple-500/10 px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-purple-500/15"
      >
        <span className="material-symbols-outlined text-[18px] text-purple-500">cookie</span>
        <span className="flex-1">
          {providerText(
            t,
            "webSessionManualGuideShow",
            "Manual paste — how to get the session credential"
          )}
        </span>
        <span className="material-symbols-outlined text-[18px]">expand_more</span>
      </button>
    );
  }

  if (requirement.kind === "none") {
    return (
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-3 text-sm text-text-muted">
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined mt-0.5 text-[18px] text-emerald-500">
            check_circle
          </span>
          <div>
            <p className="font-medium text-text-main">
              {providerText(t, "webNoAuthGuideTitle", "No credential required")}
            </p>
            <p className="mt-1">
              {providerText(
                t,
                "webNoAuthGuideBody",
                "{provider} does not need an API key or cookie. Save the connection to use its free web endpoint.",
                { provider: providerName }
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const requiredCredentialKey =
    requirement.kind === "token" ? "webTokenRequiredCredential" : "webCookieRequiredCredential";
  const requiredCredentialFallback =
    requirement.kind === "token" ? "Required token: {credential}" : "Required cookie: {credential}";
  const guideSteps = requirement.guideSteps;

  return (
    <div className="rounded-lg border border-purple-500/25 bg-purple-500/10 px-3 py-3 text-sm text-text-muted">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-purple-500">cookie</span>
        <div className="space-y-2">
          <div>
            <p className="font-medium text-text-main">
              {providerText(t, "webSessionGuideTitle", "How to get the session credential")}
            </p>
            <p className="mt-1">
              {providerText(
                t,
                "webSessionGuideIntro",
                "{provider} uses a browser web session instead of an API key.",
                { provider: providerName }
              )}
            </p>
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setManuallyExpanded(false)}
              className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                expand_less
              </span>
              {providerText(t, "webSessionManualGuideHide", "Hide the manual instructions")}
            </button>
          )}
          <p className="font-medium text-text-main">
            {providerText(t, requiredCredentialKey, requiredCredentialFallback, {
              credential: requirement.credentialName,
            })}
          </p>
          {guideSteps ? (
            <ol className="list-decimal space-y-1 pl-5">
              {guideSteps.map((step, index) => (
                <li key={step}>
                  {step}
                  {index === 0 && providerWebsite && providerWebsiteHost && (
                    <a
                      href={providerWebsite}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {providerText(t, "webSessionGuideOpenProvider", "Open {host}", {
                        host: providerWebsiteHost,
                      })}
                      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                        open_in_new
                      </span>
                    </a>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                {providerText(t, "webSessionGuideStep1", "Sign in to {provider} in your browser.", {
                  provider: providerName,
                })}
                {providerWebsite && providerWebsiteHost && (
                  <a
                    href={providerWebsite}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {providerText(t, "webSessionGuideOpenProvider", "Open {host}", {
                      host: providerWebsiteHost,
                    })}
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      open_in_new
                    </span>
                  </a>
                )}
              </li>
              <li>
                {providerText(
                  t,
                  "webSessionGuideStep2Fast",
                  "Fast path: install the Cookie Editor extension (chromewebstore.google.com → Cookie Editor), open it on the {provider} tab, find {credential} (select all numbered chunks if split), and click Export → Copy with the export format set to “Cookie header”.",
                  { provider: providerName, credential: requirement.credentialName }
                )}
              </li>
              <li>
                {providerText(
                  t,
                  "webSessionGuideStep3Manual",
                  "Manual path: open the browser developer tools (F12 → Network), refresh the page, open an authenticated request, and copy the Cookie header value from Request Headers — omit the Cookie: prefix."
                )}
              </li>
              <li>
                {providerText(
                  t,
                  "webSessionGuideStep4",
                  "Paste it here and check the connection. If it stops working, sign in again and replace it with a fresh value."
                )}
              </li>
            </ol>
          )}
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {requirement.guideNote ??
              providerText(
                t,
                "webSessionSecurityHint",
                "Treat this like a password: it may access your signed-in web account until it expires or is revoked."
              )}
          </p>
        </div>
      </div>
    </div>
  );
}
