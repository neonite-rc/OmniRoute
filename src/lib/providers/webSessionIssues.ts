/**
 * The web-session issue tracker — the "one prompt per problem" service.
 *
 * The rules the operator asked for, in one place:
 *
 *   1. The prompt fires when the problem PERSISTS — a single blip stays
 *      silent. A captcha that blocked one attempt is not yet a problem; a
 *      captcha that blocked the next attempt too is.
 *   2. The prompt fires ONCE per episode — not on every attempt.
 *   3. When the problem is solved (a successful sign-in), the prompt stops.
 *      If it comes back later, that is a new episode and may prompt again.
 *   4. When the provider is removed, its issues are forgotten and it never
 *      prompts again.
 *
 * The rules are pure functions so they can be tested without a database; the
 * persistence lives in `src/lib/db/webSessionIssues.ts`.
 */

import {
  acknowledgeWebSessionIssue as dbAcknowledge,
  deleteWebSessionIssuesForProvider as dbDeleteForProvider,
  getOpenWebSessionIssue,
  listPendingWebSessionIssues,
  markWebSessionIssueNotified,
  resolveWebSessionIssues as dbResolve,
  upsertWebSessionIssue,
  type WebSessionIssue,
  type WebSessionIssueKind,
} from "@/lib/db/webSessionIssues";

/**
 * How many observations an issue needs before the operator is prompted.
 *
 * `session_expired` is a definitive verdict — the provider answered 401/403 —
 * so one observation is already proof. `captcha_blocked` can be a one-off
 * (the operator solved it in the window), so it has to come back before it
 * counts as a persistent problem.
 */
export const WEB_SESSION_ISSUE_NOTIFY_AFTER: Record<WebSessionIssueKind, number> = {
  session_expired: 1,
  captcha_blocked: 2,
};

/** The issue kinds, for callers that need to map a reason onto one. */
export const WEB_SESSION_ISSUE_KINDS = Object.keys(
  WEB_SESSION_ISSUE_NOTIFY_AFTER
) as WebSessionIssueKind[];

/**
 * Whether an issue has been seen often enough to be worth prompting about.
 */
export function shouldNotifyWebSessionIssue(
  kind: WebSessionIssueKind,
  occurrences: number
): boolean {
  const threshold = WEB_SESSION_ISSUE_NOTIFY_AFTER[kind] ?? 1;
  return occurrences >= threshold;
}

/**
 * The prompt text for an issue.
 *
 * The message says what happened and what to do — the operator must be able
 * to act on it without opening the docs.
 */
export function describeWebSessionIssue(issue: WebSessionIssue): {
  title: string;
  message: string;
} {
  if (issue.kind === "captcha_blocked") {
    return {
      title: "Sign-in blocked by a captcha",
      message:
        `${issue.providerId} keeps hitting a captcha / anti-bot challenge when OmniRoute ` +
        `signs in. Open the provider's sign-in, solve the challenge in the sign-in window, ` +
        `and the session is captured again.`,
    };
  }
  return {
    title: "Browser session expired",
    message:
      `The saved browser session for ${issue.providerId} has expired — the provider ` +
      `rejected it. Run "Sign in with browser" (or "Re-sync session") for that provider ` +
      `to capture a fresh one.`,
  };
}

/**
 * Record that a problem was seen and announce it when it persists.
 *
 * Returns the issue plus whether this call is the one that raises the prompt.
 */
export function recordWebSessionIssue(params: {
  providerId: string;
  kind: WebSessionIssueKind;
  detail?: string | null;
}): { issue: WebSessionIssue; notify: boolean } {
  const providerId = params.providerId.trim();
  if (!providerId) {
    throw new Error("providerId is required to record a web-session issue");
  }

  const issue = upsertWebSessionIssue({
    providerId,
    kind: params.kind,
    detail: params.detail ?? null,
  });

  const notify = issue.notifiedAt === null && shouldNotifyWebSessionIssue(params.kind, issue.occurrences);
  if (notify) markWebSessionIssueNotified(issue.id);

  return { issue: notify ? { ...issue, notifiedAt: Date.now() } : issue, notify };
}

/**
 * The issues the dashboard must prompt about right now.
 *
 * Only open, announced, unacknowledged episodes are returned — a solved
 * problem and a dismissed prompt never come back.
 */
export function listWebSessionIssueAlerts(): Array<
  WebSessionIssue & { title: string; message: string }
> {
  return listPendingWebSessionIssues().map((issue) => ({
    ...issue,
    ...describeWebSessionIssue(issue),
  }));
}

/** Mark a prompt as dismissed by the operator. */
export function acknowledgeWebSessionIssueAlert(id: string): void {
  dbAcknowledge(id);
}

/**
 * Resolve a provider's issues — the problem is gone.
 *
 * Called after a successful capture: the operator fixed it, so it must not
 * prompt again.
 */
export function resolveWebSessionIssues(providerId: string): number {
  return dbResolve(providerId);
}

/**
 * Forget a provider's issues — the provider was removed.
 *
 * A problem belonging to a provider the operator deleted must never be
 * prompted about.
 */
export function forgetWebSessionIssuesForProvider(providerId: string): number {
  return dbDeleteForProvider(providerId);
}

/**
 * The open episode for a provider + kind, if any.
 *
 * Used by the capture layer to tell "this problem is new" from "this problem
 * keeps coming back".
 */
export function getOpenWebSessionIssueForProvider(
  providerId: string,
  kind: WebSessionIssueKind
): WebSessionIssue | null {
  return getOpenWebSessionIssue(providerId, kind);
}
