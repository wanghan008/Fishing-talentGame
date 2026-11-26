-- Copy each existing account's current save_json.coins into player_wallets.
-- Run only after 0001_wallet_schema.sql and after checking migrations/README.md.
-- This script is idempotent: existing wallet rows and migration ledger entries
-- are not overwritten. It does not modify or delete player_saves.

INSERT OR IGNORE INTO player_wallets (user_id, coins, created_at, updated_at)
SELECT
  u.id,
  CASE
    WHEN p.save_json IS NULL THEN 0
    WHEN json_valid(p.save_json) = 0 THEN 0
    WHEN json_type(p.save_json, '$.coins') = 'integer'
      AND json_extract(p.save_json, '$.coins') >= 0
      AND json_extract(p.save_json, '$.coins') <= 9999999999
    THEN json_extract(p.save_json, '$.coins')
    ELSE 0
  END AS coins,
  CAST(strftime('%s', 'now') AS INTEGER),
  CAST(strftime('%s', 'now') AS INTEGER)
FROM users u
LEFT JOIN player_saves p ON p.user_id = u.id;

-- Record the original balance as a one-time opening-balance transaction.
-- The unique (type, reference_id) constraint prevents duplicate ledger rows
-- if this migration is run again.
INSERT OR IGNORE INTO coin_transactions
  (id, user_id, amount, balance_after, type, reference_id, note, created_at)
SELECT
  'wallet-migration-v1:' || w.user_id,
  w.user_id,
  w.coins,
  w.coins,
  'migration_opening_balance',
  'wallet-migration-v1:' || w.user_id,
  'Initial balance copied from player_saves.save_json.coins',
  CAST(strftime('%s', 'now') AS INTEGER)
FROM player_wallets w;
