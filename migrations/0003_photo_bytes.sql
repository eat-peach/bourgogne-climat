-- Bytes stored in R2 for each submission's photos, so the Worker can enforce LIMITS.photoStorageBytes.
ALTER TABLE submissions ADD COLUMN photo_bytes INTEGER NOT NULL DEFAULT 0;
