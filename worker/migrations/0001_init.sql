-- Shared sign-ups for the haystack potluck.
-- A signup is one submission (name, party size, notes) and can cover several items.
-- claim_key is unique. Exclusive dishes use the item name, so a second insert fails.
-- Cooked Rice uses a per-signup key and can be claimed more than once.

CREATE TABLE signups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  party INTEGER NOT NULL CHECK (party >= 1 AND party <= 99),
  notes TEXT NOT NULL DEFAULT '',
  cancel_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE signup_items (
  signup_id TEXT NOT NULL,
  item TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  PRIMARY KEY (signup_id, item),
  FOREIGN KEY (signup_id) REFERENCES signups(id) ON DELETE CASCADE,
  UNIQUE (claim_key)
);

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL
);
