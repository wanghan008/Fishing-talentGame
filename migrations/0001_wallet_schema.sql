-- Fish game wallet foundation.
-- Safe to apply before application code switches to player_wallets.
-- This migration does not modify player_saves or any existing player balance.

CREATE TABLE IF NOT EXISTS player_wallets (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coins INTEGER NOT NULL DEFAULT 0 CHECK (typeof(coins) = 'integer' AND coins >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  balance_after INTEGER NOT NULL CHECK (typeof(balance_after) = 'integer' AND balance_after >= 0),
  type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_player_wallets_coins
  ON player_wallets(coins DESC);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_user_time
  ON coin_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coin_transactions_reference
  ON coin_transactions(reference_id);
