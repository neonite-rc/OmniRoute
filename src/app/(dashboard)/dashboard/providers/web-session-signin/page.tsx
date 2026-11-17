"use client";

/**
 * Web-session sign-in — the tab the dashboard opens to sign in.
 *
 * The dashboard's **Sign in with browser** button opens this page in a NEW TAB
 * of the very browser the dashboard is running in, so the sign-in always
 * happens where the operator is looking:
 *
 *  - The OmniRoute host has a display and the dashboard runs on it → a
 *    browser window opens on that machine (in the browser family this tab
 *    reports), and this tab keeps the operator posted.
 *  - The host is headless, or the dashboard is open on another machine → the
 *    host runs the browser without a display and streams the login page into
 *    this tab. The operator clicks and types right here.
 *
 * Either way the session is captured on the host, and the credential is handed
 * back to the dashboard tab this one was opened from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import {
  WEB_SESSION_SIGNIN_MESSAGE,
  type WebSessionSigninResult,
} from "@/lib/providers/webSessionSigninMessage";

/** One frame of the streamed sign-in view. */
interface StreamFrame {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

type Phase = "starting" | "native" | "streaming" | "done" | "error";

export default function WebSessionSigninPage() {
  const t = useTranslations("providers");
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<StreamFrame | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const streamSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  const query = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const providerId = query?.get("provider") ?? "";
  const providerName = query?.get("name") ?? "";
  const mode = query?.get("mode") === "sync" ? "sync" : "add";
  const connectionId = query?.get("connectionId") ?? "";

  // The provider the operator is signing in to.
  const provider = providerName || providerId;
  // A tab opened without a provider cannot sign in — that is a broken link,
  // not a state the sign-in reaches.
  const missingProvider = !providerId;
  const shownPhase: Phase = missingProvider ? "error" : phase;
  const shownError = missingProvider ? "No provider was given." : error;

  /** Hand the captured session back to the dashboard tab and close this one. */
  const deliver = useCallback((result: WebSessionSigninResult) => {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(result, window.location.origin);
      }
    } catch {
      // The opener is gone — nothing to hand the result to.
    }
    setPhase(result.success ? "done" : "error");
    if (!result.success) setError(result.error ?? "Sign-in did not complete");
    // Give the operator a moment to read the outcome before the tab closes.
    setTimeout(() => {
      try {
        window.close();
      } catch {
        // A tab that was not opened by script cannot close itself.
      }
    }, 1200);
  }, []);

  /** Follow the streamed sign-in and forward the operator's input. */
  const followStream = useCallback(
    (sessionId: string) => {
      sessionIdRef.current = sessionId;
      const source = new EventSource(
        `/api/providers/web-session-login/stream?sessionId=${encodeURIComponent(sessionId)}`
      );
      streamSourceRef.current = source;

      source.addEventListener("frame", (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as StreamFrame;
          if (typeof parsed?.data === "string") setFrame(parsed);
        } catch {
          // A malformed frame is skipped — the next one arrives shortly.
        }
      });

      source.addEventListener("status", (event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as { message?: string };
          if (typeof parsed?.message === "string") setStatus(parsed.message);
        } catch {
          // Ignore an unreadable status line.
        }
      });

      source.addEventListener("result", (event) => {
        source.close();
        streamSourceRef.current = null;
        sessionIdRef.current = null;
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as {
            success?: boolean;
            error?: string;
            credential?: string;
            providerSpecificData?: Record<string, unknown>;
            alreadySignedIn?: boolean;
          };
          deliver({
            type: WEB_SESSION_SIGNIN_MESSAGE,
            success: parsed?.success === true,
            credential: parsed?.credential,
            providerSpecificData: parsed?.providerSpecificData,
            alreadySignedIn: parsed?.alreadySignedIn,
            error: parsed?.error,
          });
        } catch {
          deliver({
            type: WEB_SESSION_SIGNIN_MESSAGE,
            success: false,
            error: "Browser sign-in did not complete. Try again, or paste the credential manually.",
          });
        }
      });

      source.addEventListener("error", (event) => {
        // The server sends its own errors with a message. The browser's native
        // error event (a dropped connection) carries no data — EventSource
        // reconnects by itself, and the sign-in on the host is still running,
        // so it must not be reported as a failure.
        const raw = (event as MessageEvent).data;
        if (typeof raw !== "string" || !raw) return;

        let message = "";
        try {
          const parsed = JSON.parse(raw) as { message?: string };
          message = parsed?.message ?? "";
        } catch {
          message = "";
        }
        source.close();
        streamSourceRef.current = null;
        sessionIdRef.current = null;
        deliver({
          type: WEB_SESSION_SIGNIN_MESSAGE,
          success: false,
          error:
            message ||
            "Browser sign-in did not complete. Try again, or paste the credential manually.",
        });
      });
    },
    [deliver]
  );

  // Start the sign-in.
  useEffect(() => {
    // Without a provider there is nothing to sign in to — the render already
    // shows that (see `missingProvider`).
    if (!providerId) return;

    let cancelled = false;

    // Where does the sign-in happen? The native sign-in only answers when the
    // operator is done, so the tab says where the window opens while it waits.
    void fetch("/api/providers/web-session-browser")
      .then((response) => (response.ok ? response.json() : null))
      .then((info: { signInMode?: unknown } | null) => {
        if (cancelled || info?.signInMode !== "native") return;
        // The streamed view replaces this as soon as it starts.
        setPhase((current) => (current === "starting" ? "native" : current));
      })
      .catch(() => {
        // The hint is a nicety — the sign-in works without it.
      });

    const start = async () => {
      try {
        const isSync = mode === "sync" && !!connectionId;
        const response = await fetch(
          isSync
            ? `/api/providers/${encodeURIComponent(connectionId)}/login`
            : "/api/providers/web-session-login",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              isSync
                ? { browser: detectFamily() }
                : { provider: providerId, browser: detectFamily() }
            ),
          }
        );
        const data = (await response.json().catch(() => null)) as {
          success?: boolean;
          error?: string;
          mode?: string;
          sessionId?: string;
          credential?: string;
          providerSpecificData?: Record<string, unknown>;
          alreadySignedIn?: boolean;
        } | null;

        if (cancelled) return;

        if (!response.ok || !data?.success) {
          deliver({
            type: WEB_SESSION_SIGNIN_MESSAGE,
            success: false,
            error: data?.error ?? "Browser sign-in did not complete.",
          });
          return;
        }

        // The sign-in runs on the host and its view is streamed here.
        if (data.mode === "stream" && typeof data.sessionId === "string") {
          setPhase("streaming");
          followStream(data.sessionId);
          return;
        }

        // A window opened on the host: the request only returns once the
        // operator is done signing in.
        setPhase("native");
        deliver({
          type: WEB_SESSION_SIGNIN_MESSAGE,
          success: true,
          credential: data.credential,
          providerSpecificData: data.providerSpecificData,
          alreadySignedIn: data.alreadySignedIn,
        });
      } catch {
        deliver({
          type: WEB_SESSION_SIGNIN_MESSAGE,
          success: false,
          error: "Browser sign-in did not complete. Try again, or paste the credential manually.",
        });
      }
    };

    void start();

    return () => {
      cancelled = true;
      streamSourceRef.current?.close();
      streamSourceRef.current = null;
      sessionIdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, providerName, mode, connectionId]);

  /** Send one operator action into the streamed page. */
  const sendInput = useCallback((event: Record<string, unknown>) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    void fetch("/api/providers/web-session-login/stream/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, event }),
    }).catch(() => {
      // A dropped input is visible in the next frame.
    });
  }, []);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      const image = event.currentTarget;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height || !frame) return;
      sendInput({
        type: "click",
        x: ((event.clientX - rect.left) / rect.width) * frame.width,
        y: ((event.clientY - rect.top) / rect.height) * frame.height,
      });
    },
    [frame, sendInput]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (printable) {
        sendInput({ type: "key", text: event.key });
      } else {
        sendInput({ type: "press", key: event.key });
      }
      // The keystroke belongs to the streamed page, not to this tab.
      event.preventDefault();
    },
    [sendInput]
  );

  useEffect(() => {
    if (shownPhase === "streaming") focusRef.current?.focus();
  }, [shownPhase]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6 text-text-main">
      <header>
        <h1 className="text-lg font-semibold">
          {t("webSessionSigninTitle", { provider: provider || "the provider" })}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {shownPhase === "native"
            ? t("webSessionSigninNativeHint")
            : shownPhase === "streaming"
              ? t("webSessionSigninStreamHint")
              : shownPhase === "done"
                ? t("webSessionSigninDone")
                : shownPhase === "error"
                  ? t("webSessionSigninFailed")
                  : t("webSessionStreamStarting")}
        </p>
        {status && <p className="mt-1 text-xs text-text-muted">{status}</p>}
      </header>

      {shownPhase === "streaming" && (
        <div
          ref={focusRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="outline-none focus:ring-2 focus:ring-emerald-500/60"
        >
          {frame ? (
            // A live frame of the sign-in page — a data URL, so the
            // next/image optimizer does not apply.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/jpeg;base64,${frame.data}`}
              alt={t("webSessionStreamFrameAlt", { provider: provider || "the provider" })}
              onClick={handleClick}
              className="block w-full cursor-pointer rounded border border-black/30"
            />
          ) : (
            <div className="flex h-64 items-center justify-center rounded border border-dashed border-emerald-500/30 text-sm text-text-muted">
              {t("webSessionStreamWaiting")}
            </div>
          )}
        </div>
      )}

      {shownError && <p className="text-sm text-rose-400">{shownError}</p>}
    </main>
  );
}

/** The browser family the dashboard is running in. */
function detectFamily(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Firefox\//i.test(ua)) return "firefox";
  if (/Edg\//i.test(ua)) return "edge";
  if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return "chrome";
  if (/Safari\//i.test(ua)) return "safari";
  return "unknown";
}
