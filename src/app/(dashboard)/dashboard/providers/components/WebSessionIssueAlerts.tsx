"use client";

/**
 * WebSessionIssueAlerts — raises ONE dashboard prompt per web-session problem.
 *
 * A web-session provider can go bad in a way the provider list does not show:
 * the saved session expires, or a captcha / anti-bot challenge stands in front
 * of the sign-in. The server tracks those problems and only announces the ones
 * that PERSIST (see `src/lib/providers/webSessionIssues.ts`).
 *
 * This component polls the alert list and shows a toast for every alert it has
 * not shown yet. The alert is acknowledged as soon as it is shown, so:
 *
 *   - the same episode never prompts twice (not on every attempt),
 *   - a problem the operator solved never prompts again,
 *   - a provider the operator removed never prompts at all.
 *
 * If the dashboard is closed, nothing is fetched and nothing is acknowledged —
 * the prompt is waiting the next time the operator opens the dashboard.
 */

import { useEffect, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";

/** How often the dashboard looks for a new problem. */
const POLL_INTERVAL_MS = 60_000;

/** How long the toast stays up — long enough to read and act on. */
const TOAST_DURATION_MS = 15_000;

interface WebSessionIssueAlert {
  id: string;
  providerId: string;
  kind: string;
  title?: string;
  message?: string;
}

export default function WebSessionIssueAlerts() {
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const acknowledge = async (id: string) => {
      try {
        await fetch("/api/providers/web-session-issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } catch {
        // The prompt was already shown; a failed acknowledgement only means
        // the same alert may be shown once more after a reload.
      }
    };

    const check = async () => {
      try {
        const response = await fetch("/api/providers/web-session-issues", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: WebSessionIssueAlert[] };
        const alerts = Array.isArray(payload?.data) ? payload.data : [];

        for (const alert of alerts) {
          if (cancelled || !alert?.id || shownRef.current.has(alert.id)) continue;
          shownRef.current.add(alert.id);

          useNotificationStore.getState().addNotification({
            type: "warning",
            title: alert.title || "Web-session problem",
            message: alert.message || `The saved browser session for ${alert.providerId} needs attention.`,
            duration: TOAST_DURATION_MS,
          });

          // Acknowledged on show: one prompt per episode, never one per attempt.
          void acknowledge(alert.id);
        }
      } catch {
        // The dashboard must keep working when the alert list is unreachable.
      }
    };

    void check();
    const timer = setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
