CREATE TABLE time_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  project TEXT NOT NULL CHECK (length(project) <= 65535),
  task TEXT NOT NULL CHECK (length(task) <= 65535),
  description TEXT NOT NULL CHECK (length(description) <= 65535),
  start_at TEXT NOT NULL CHECK (length(start_at) BETWEEN 1 AND 32),
  end_at TEXT CHECK (end_at IS NULL OR length(end_at) BETWEEN 1 AND 32),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  status TEXT NOT NULL CHECK (status IN ('ok', 'needs_review')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 32),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 32),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(deleted_at) BETWEEN 1 AND 32),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  multiply TEXT CHECK (multiply IS NULL OR length(multiply) <= 32),
  remote_version INTEGER NOT NULL DEFAULT 1 CHECK (remote_version >= 1)
);

CREATE INDEX time_entries_start_at_idx ON time_entries(start_at);
CREATE INDEX time_entries_updated_at_idx ON time_entries(updated_at);
CREATE INDEX time_entries_deleted_at_idx ON time_entries(deleted_at);

CREATE TABLE config (
  key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  value TEXT NOT NULL CHECK (length(value) <= 65535),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 32),
  remote_version INTEGER NOT NULL DEFAULT 1 CHECK (remote_version >= 1)
);

CREATE TABLE app_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  change_seq INTEGER NOT NULL CHECK (change_seq >= 1)
);

INSERT INTO app_meta(id, schema_version, change_seq) VALUES (1, 1, 1);

CREATE TABLE mutation_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value IS NOT NULL)
);
