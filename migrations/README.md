# Fish wallet migration (Phase 1A)

These SQL files establish the wallet tables and copy existing player balances.
They do **not** change the game API, client code, leaderboard, or admin console.
They do **not** run automatically when the Worker deploys.

## Important safety rules

1. Do not run these files against production until a D1 backup/export has been made.
2. Run the preflight queries below first. Resolve any malformed save JSON or invalid
   coin values before proceeding; do not accept a migration that silently turns a
   real player's balance into zero.
3. Apply `0001_wallet_schema.sql` first, then `0002_wallet_backfill.sql`.
4. Do not switch the application to read from `player_wallets` yet. The existing
   API and client still use `player_saves.save_json.coins` until Phase 1B/1C.
5. Do not delete or rewrite `save_json.coins`. It remains the compatibility source
   until the application cutover has been implemented and verified.

## Preflight: find malformed save JSON

Run in the Cloudflare D1 Console:

```sql
SELECT user_id, updated_at
FROM player_saves
WHERE save_json IS NULL OR json_valid(save_json) = 0;
```

This query should return no rows. If it returns rows, inspect and repair those saves
before applying the backfill.

## Preflight: find missing, non-integer, negative, or out-of-range balances

```sql
WITH classified AS (
  SELECT
    user_id,
    CASE
      WHEN save_json IS NULL OR json_valid(save_json) = 0 THEN 'invalid_json'
      WHEN json_type(save_json, '$.coins') IS NULL THEN 'missing_coins'
      WHEN json_type(save_json, '$.coins') <> 'integer' THEN 'coins_not_integer'
      WHEN json_extract(save_json, '$.coins') < 0 THEN 'coins_negative'
      WHEN json_extract(save_json, '$.coins') > 9999999999 THEN 'coins_out_of_range'
      ELSE 'ok'
    END AS issue
  FROM player_saves
)
SELECT user_id, issue
FROM classified
WHERE issue <> 'ok';
```

Resolve every returned row before backfill. Also check for accounts without a save:

```sql
SELECT u.id, u.username
FROM users u
LEFT JOIN player_saves p ON p.user_id = u.id
WHERE p.user_id IS NULL;
```

Accounts without a save are initialized with 0 coins by the backfill; confirm that
this is appropriate before proceeding.

## Apply

In Cloudflare Dashboard, open **Workers & Pages → D1 → fishjoy-account-db → Console**.
Paste and execute the complete contents of `0001_wallet_schema.sql`. After it
succeeds, execute the complete contents of `0002_wallet_backfill.sql`.

These scripts are safe to re-run: table/index creation uses `IF NOT EXISTS`,
wallet inserts use `INSERT OR IGNORE`, and opening-balance ledger entries have a
unique idempotency key.

## Verify after backfill

```sql
SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM player_wallets) AS wallet_count,
  (SELECT COUNT(*) FROM coin_transactions
    WHERE type = 'migration_opening_balance') AS migrated_ledger_count;
```

The three counts should match, except for any account rows intentionally excluded
from the migration plan. Check the balances against the original saves:

```sql
SELECT
  u.id,
  u.username,
  CAST(json_extract(p.save_json, '$.coins') AS INTEGER) AS legacy_coins,
  w.coins AS wallet_coins
FROM users u
JOIN player_saves p ON p.user_id = u.id
JOIN player_wallets w ON w.user_id = u.id
WHERE CAST(json_extract(p.save_json, '$.coins') AS INTEGER) <> w.coins;
```

This comparison should return no rows.

## Rollback

Do not drop the wallet tables as a casual rollback. They contain the copied balances
and audit opening entries. Since application cutover has not happened in Phase 1A,
the existing game continues using `player_saves`; leave the new tables unused until
the next phase is ready. If a rollback is necessary, take another backup and review
the data before any destructive SQL.
