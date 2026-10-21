BEGIN;

-- Aggregate daily counts only: no account, device, worker, path, or tool
-- argument is recorded. Metrics starting with peak_ hold a daily maximum;
-- every other metric is a daily sum.
CREATE TABLE IF NOT EXISTS usage_daily (
  day date NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z_]{1,64}$'),
  value bigint NOT NULL CHECK (value >= 0),
  PRIMARY KEY (day, metric)
);

COMMIT;
