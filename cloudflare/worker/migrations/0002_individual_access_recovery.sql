-- Individual access IDs and one-time email recovery links.
-- Existing purchases receive an opaque access_id so previously approved orders
-- can use the recovery flow after this migration is applied.
ALTER TABLE purchases ADD COLUMN access_id TEXT;
ALTER TABLE purchases ADD COLUMN recovery_token_hash TEXT;
ALTER TABLE purchases ADD COLUMN recovery_token_expires_at TEXT;
ALTER TABLE purchases ADD COLUMN recovery_token_used_at TEXT;
ALTER TABLE purchases ADD COLUMN recovery_last_sent_at TEXT;

UPDATE purchases
SET access_id = lower(hex(randomblob(16)))
WHERE access_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_access_id
ON purchases(access_id);
