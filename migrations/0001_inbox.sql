CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  archive_hash TEXT NOT NULL,
  envelope TEXT,
  payload_bytes INTEGER NOT NULL,
  workout_count INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','retrying','failed','archived')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  commit_sha TEXT,
  archived_at TEXT
);
CREATE INDEX batches_due ON batches(state, next_attempt, received_at);
CREATE TABLE delivery_lease (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  token TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE rate_windows (
  role TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
CREATE TABLE upload_health (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_upload_at TEXT NOT NULL
);
CREATE TABLE delivery_backoff (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  not_before INTEGER NOT NULL
);
