-- Failed admin sign-ins, for throttling password guesses (salted IP hash only).
CREATE TABLE IF NOT EXISTS admin_failures (
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_failures_ip_created ON admin_failures (ip_hash, created_at);
