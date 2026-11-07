-- Visitor feedback and data-correction requests. Photos live in R2; only their keys are stored here.
CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('feedback', 'correction')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'accepted', 'rejected', 'spam')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  category      TEXT,
  message       TEXT NOT NULL,
  proposed      TEXT,
  evidence      TEXT,
  contact_name  TEXT,
  contact_email TEXT,
  target_json   TEXT,
  page          TEXT,
  user_agent    TEXT,
  country       TEXT,
  ip_hash       TEXT NOT NULL,
  photo_keys    TEXT NOT NULL DEFAULT '[]',
  admin_note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_created ON submissions (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_status_created ON submissions (status, created_at);
