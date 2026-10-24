-- 00 — extensions. gen_random_uuid() and md5() are in core on pg16.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Hyperfunctions (M4). Present in timescaledb-ha and on Tiger Cloud; degrade
-- gracefully on a plain postgres image so migrations still succeed.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb_toolkit unavailable (%); hyperfunction features skipped', SQLERRM;
END $$;
