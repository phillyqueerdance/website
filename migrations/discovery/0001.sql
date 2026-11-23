CREATE TABLE IF NOT EXISTS discovery_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_posts (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL,
  reserved_usd REAL NOT NULL DEFAULT 0, actual_usd REAL,
  data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discovery_runs_day ON discovery_runs(day);
CREATE TABLE IF NOT EXISTS discovery_items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('event','correction')),
  date TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL,
  edits TEXT NOT NULL DEFAULT '{}', decision TEXT NOT NULL DEFAULT 'WAIT',
  status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
  is_new INTEGER NOT NULL DEFAULT 1, is_updated INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
  lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discovery_items_view ON discovery_items(status,decision,date);
CREATE TABLE IF NOT EXISTS discovery_aliases (
  alias TEXT NOT NULL, item_id TEXT NOT NULL,
  PRIMARY KEY(alias,item_id), FOREIGN KEY(item_id) REFERENCES discovery_items(id)
);
CREATE TABLE IF NOT EXISTS discovery_decisions (
  alias TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL,
  date TEXT NOT NULL, decision TEXT NOT NULL, updated_at TEXT NOT NULL
);
