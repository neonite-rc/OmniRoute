-- 174: web_session_issues — persistent problems with a browser session.
--
-- A web-session provider can go bad in two ways the operator cannot see from
-- the provider list: the saved session expires (the provider answers 401/403),
-- or a captcha / anti-bot challenge stands in front of the sign-in. Both are
-- recorded here so the dashboard can raise ONE prompt per problem episode —
-- not one per attempt.
--
-- Rows are keyed by (provider_id, issue_kind). An open row (resolved_at IS
-- NULL) is the current episode; a resolved row is history. The partial unique
-- index keeps exactly one open episode per provider + kind.

CREATE TABLE IF NOT EXISTS web_session_issues (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  issue_kind TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  notified_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_session_issues_provider
  ON web_session_issues(provider_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_web_session_issues_open_episode
  ON web_session_issues(provider_id, issue_kind)
  WHERE resolved_at IS NULL;
