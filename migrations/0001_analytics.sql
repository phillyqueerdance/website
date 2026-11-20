-- Run once in the qdp-analytics D1 console. This database contains aggregate
-- public-site activity only: no visitor IDs, IPs, raw URLs or search text.
CREATE TABLE IF NOT EXISTS qdp_analytics_counts (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, kind, entity_id, source, device)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS qdp_analytics_budget (
  day TEXT PRIMARY KEY,
  units INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT NOT NULL DEFAULT '',
  limited INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS qdp_analytics_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  last_seen_at TEXT
);
INSERT OR IGNORE INTO qdp_analytics_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS qdp_analytics_gaps (
  started_at TEXT PRIMARY KEY,
  ended_at TEXT,
  reason TEXT NOT NULL DEFAULT 'paused'
) WITHOUT ROWID;
