CREATE TABLE IF NOT EXISTS referral_users (
  chat_id TEXT PRIMARY KEY,
  referrer_chat_id TEXT,
  started_at INTEGER NOT NULL,
  CHECK (referrer_chat_id IS NULL OR referrer_chat_id <> chat_id)
);

CREATE INDEX IF NOT EXISTS referral_users_referrer_idx
  ON referral_users (referrer_chat_id);
