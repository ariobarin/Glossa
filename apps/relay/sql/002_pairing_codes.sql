BEGIN;

CREATE TABLE IF NOT EXISTS pairing_codes (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE,
  device_name text NOT NULL,
  platform text,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz
);

CREATE INDEX IF NOT EXISTS pairing_codes_expires_idx ON pairing_codes(expires_at);

COMMIT;
