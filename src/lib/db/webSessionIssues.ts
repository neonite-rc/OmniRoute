/**
 * db/webSessionIssues.ts — persistent problems with a browser session.
 *
 * A web-session provider can go bad in a way the provider list does not show:
 * the saved session expires, or a captcha / anti-bot challenge stands in front
 * of the sign-in. Both are recorded here so the dashboard can raise exactly
 * ONE prompt per problem episode:
 *
 *   - the first occurrence is recorded but not announced (a blip is not a
 *     problem the operator must act on),
 *   - the prompt fires once the problem persists,
 *   - a successful sign-in resolves the episode, so a solved problem never
 *     prompts again,
 *   - removing the provider deletes the rows, so a provider the operator
 *     dropped never prompts again.
 *
 * All SQL lives here — routes and services go through these functions.
 */

import { randomUUID } from "crypto";
import { getDbInstance, rowToCamel } from "./core";

/** The kinds of problem a web session can hit. */
export type WebSessionIssueKind = "session_expired" | "captcha_blocked";

export interface WebSessionIssue {
  id: string;
  providerId: string;
  kind: WebSessionIssueKind;
  /** How many times the problem was observed in this episode. */
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** When the prompt was raised (null while the problem is still a blip). */
  notifiedAt: number | null;
  /** When the operator dismissed the prompt. */
  acknowledgedAt: number | null;
  /** When the problem was solved — a later occurrence starts a NEW episode. */
  resolvedAt: number | null;
  detail: string | null;
}

interface WebSessionIssueRow {
  id: string;
  provider_id: string;
  issue_kind: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  notified_at: number | null;
  acknowledged_at: number | null;
  resolved_at: number | null;
  detail: string | null;
}

function toIssue(row: WebSessionIssueRow): WebSessionIssue {
  const camel = rowToCamel(row) as unknown as Record<string, unknown>;
  return {
    id: String(camel.id ?? ""),
    providerId: String(camel.providerId ?? ""),
    kind: String(camel.kind ?? camel.issueKind ?? "") as WebSessionIssueKind,
    occurrences: Number(camel.occurrences ?? 0),
    firstSeenAt: Number(camel.firstSeenAt ?? 0),
    lastSeenAt: Number(camel.lastSeenAt ?? 0),
    notifiedAt: camel.notifiedAt === null || camel.notifiedAt === undefined ? null : Number(camel.notifiedAt),
    acknowledgedAt:
      camel.acknowledgedAt === null || camel.acknowledgedAt === undefined
        ? null
        : Number(camel.acknowledgedAt),
    resolvedAt:
      camel.resolvedAt === null || camel.resolvedAt === undefined ? null : Number(camel.resolvedAt),
    detail: camel.detail === null || camel.detail === undefined ? null : String(camel.detail),
  };
}

/**
 * Record that a problem was seen.
 *
 * The open episode for (provider, kind) is reused, so the occurrence count
 * keeps growing across attempts. Once the episode is resolved a NEW episode
 * starts — a problem that comes back deserves a fresh prompt.
 */
export function upsertWebSessionIssue(params: {
  providerId: string;
  kind: WebSessionIssueKind;
  detail?: string | null;
  now?: number;
}): WebSessionIssue {
  const db = getDbInstance();
  const now = params.now ?? Date.now();
  const providerId = params.providerId.trim();
  const detail = params.detail ?? null;

  const existing = db
    .prepare(
      `SELECT id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at,
              notified_at, acknowledged_at, resolved_at, detail
         FROM web_session_issues
        WHERE provider_id = ? AND issue_kind = ? AND resolved_at IS NULL
        LIMIT 1`
    )
    .get(providerId, params.kind) as WebSessionIssueRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE web_session_issues
          SET occurrences = occurrences + 1,
              last_seen_at = ?,
              detail = COALESCE(?, detail)
        WHERE id = ?`
    ).run(now, detail, existing.id);
    return getWebSessionIssue(existing.id) as WebSessionIssue;
  }

  const id = `wsi_${randomUUID()}`;
  db.prepare(
    `INSERT INTO web_session_issues
       (id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at, detail)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run(id, providerId, params.kind, now, now, detail);

  return getWebSessionIssue(id) as WebSessionIssue;
}

/** Read one issue by id. */
export function getWebSessionIssue(id: string): WebSessionIssue | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at,
              notified_at, acknowledged_at, resolved_at, detail
         FROM web_session_issues
        WHERE id = ?`
    )
    .get(id) as WebSessionIssueRow | undefined;
  return row ? toIssue(row) : null;
}

/**
 * The open episode for a provider + kind, if there is one.
 */
export function getOpenWebSessionIssue(
  providerId: string,
  kind: WebSessionIssueKind
): WebSessionIssue | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at,
              notified_at, acknowledged_at, resolved_at, detail
         FROM web_session_issues
        WHERE provider_id = ? AND issue_kind = ? AND resolved_at IS NULL
        LIMIT 1`
    )
    .get(providerId, kind) as WebSessionIssueRow | undefined;
  return row ? toIssue(row) : null;
}

/**
 * The issues the dashboard must prompt about.
 *
 * An issue qualifies when it was announced (the problem persisted), is still
 * open (not solved) and was not dismissed by the operator.
 */
export function listPendingWebSessionIssues(): WebSessionIssue[] {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at,
              notified_at, acknowledged_at, resolved_at, detail
         FROM web_session_issues
        WHERE resolved_at IS NULL
          AND notified_at IS NOT NULL
          AND acknowledged_at IS NULL
        ORDER BY last_seen_at DESC`
    )
    .all() as WebSessionIssueRow[];
  return rows.map(toIssue);
}

/** Every open issue, announced or not — used by the diagnostics view. */
export function listOpenWebSessionIssues(): WebSessionIssue[] {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT id, provider_id, issue_kind, occurrences, first_seen_at, last_seen_at,
              notified_at, acknowledged_at, resolved_at, detail
         FROM web_session_issues
        WHERE resolved_at IS NULL
        ORDER BY last_seen_at DESC`
    )
    .all() as WebSessionIssueRow[];
  return rows.map(toIssue);
}

/** Mark an issue as announced — the prompt has been raised for this episode. */
export function markWebSessionIssueNotified(id: string, now = Date.now()): void {
  const db = getDbInstance();
  db.prepare(
    `UPDATE web_session_issues SET notified_at = ? WHERE id = ? AND notified_at IS NULL`
  ).run(now, id);
}

/** Mark an issue as dismissed by the operator. */
export function acknowledgeWebSessionIssue(id: string, now = Date.now()): void {
  const db = getDbInstance();
  db.prepare(
    `UPDATE web_session_issues SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`
  ).run(now, id);
}

/**
 * Resolve the open issues of a provider — the problem is gone.
 *
 * A successful sign-in resolves them. The next occurrence opens a NEW episode,
 * which may prompt again.
 */
export function resolveWebSessionIssues(
  providerId: string,
  kind?: WebSessionIssueKind,
  now = Date.now()
): number {
  const db = getDbInstance();
  const result = kind
    ? db
        .prepare(
          `UPDATE web_session_issues SET resolved_at = ?
            WHERE provider_id = ? AND issue_kind = ? AND resolved_at IS NULL`
        )
        .run(now, providerId, kind)
    : db
        .prepare(
          `UPDATE web_session_issues SET resolved_at = ?
            WHERE provider_id = ? AND resolved_at IS NULL`
        )
        .run(now, providerId);
  return result.changes ?? 0;
}

/**
 * Forget a provider's issues entirely.
 *
 * Called when the operator removes the provider: a problem belonging to a
 * provider that no longer exists must never be prompted about.
 */
export function deleteWebSessionIssuesForProvider(providerId: string): number {
  const db = getDbInstance();
  const result = db
    .prepare("DELETE FROM web_session_issues WHERE provider_id = ?")
    .run(providerId);
  return result.changes ?? 0;
}
