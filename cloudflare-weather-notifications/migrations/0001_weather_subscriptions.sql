CREATE TABLE IF NOT EXISTS weather_subscriptions (
  chat_id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sent_at TEXT
);

CREATE INDEX IF NOT EXISTS weather_subscriptions_due_idx
  ON weather_subscriptions (enabled, last_sent_at);
