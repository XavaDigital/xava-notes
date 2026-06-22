-- Single-user key/value config: stores the Google refresh_token and the
-- device_token (the bearer secret the PWA uses to call this API).
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Web Push subscriptions (one per installed device/browser).
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER
);

-- Scheduled reminders. due_at is epoch milliseconds.
CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  note_id    TEXT,
  title      TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  sent       INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent, due_at);

-- Durable write-relay/outbox: the PWA posts note writes here; the worker
-- persists them to Drive (immediately, then retried by cron on failure).
CREATE TABLE IF NOT EXISTS outbox (
  id             TEXT PRIMARY KEY,
  op             TEXT NOT NULL,        -- 'put' | 'delete'
  note_id        TEXT,
  file_id        TEXT,                 -- set for updates/deletes
  name           TEXT,
  content        TEXT,
  app_props      TEXT,                 -- JSON
  status         TEXT DEFAULT 'pending', -- pending | done | error
  attempts       INTEGER DEFAULT 0,
  last_error     TEXT,
  result_file_id TEXT,
  created_at     INTEGER,
  updated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, created_at);
