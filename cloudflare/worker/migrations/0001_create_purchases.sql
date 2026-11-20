CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  amount_in_cents INTEGER NOT NULL CHECK (amount_in_cents = 490000),
  currency TEXT NOT NULL CHECK (currency = 'COP'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'rejected', 'revoked')),
  access_token_hash TEXT NOT NULL,
  wompi_transaction_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchases_status_created
  ON purchases (status, created_at);
