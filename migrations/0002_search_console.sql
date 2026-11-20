-- Search Console is separate from first-party visitor counters.
-- Credentials are encrypted with a production-only Cloudflare secret.
CREATE TABLE IF NOT EXISTS qdp_search_console (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_cipher TEXT,
  grant_cipher TEXT,
  property TEXT,
  version TEXT NOT NULL DEFAULT '',
  connected_at TEXT,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  report_day TEXT NOT NULL DEFAULT '',
  report_count INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO qdp_search_console (id) VALUES (1);

CREATE TABLE IF NOT EXISTS qdp_search_reports (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
) WITHOUT ROWID;
