CREATE TABLE IF NOT EXISTS pro_subscriptions (
  chat_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  telegram_payment_charge_id TEXT NOT NULL,
  auto_renewing INTEGER NOT NULL DEFAULT 1,
  last_payment_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pro_subscriptions_expiry_idx
  ON pro_subscriptions (expires_at);

CREATE TABLE IF NOT EXISTS pro_payments (
  telegram_payment_charge_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  is_first_recurring INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pro_payments_chat_id_idx
  ON pro_payments (chat_id);
