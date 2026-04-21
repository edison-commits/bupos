#!/usr/bin/env bash
# R8-L-12: apply migrations + seed to the test Postgres.
#
# Idempotent: each migration runs through a simple _migrations tracker
# (mirrors the prod deploy.yml pattern) so re-running only applies new
# files.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54329/bupos_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Waiting for Postgres (DATABASE_URL=$DB_URL)..."
for _ in $(seq 1 30); do
  if psql "$DB_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "→ Creating Supabase compatibility roles (anon, authenticated, service_role)"
# Migration 027/028/040 etc. REVOKE/GRANT on these roles which exist on
# Supabase-hosted Postgres but not plain postgres:17-alpine. Create them
# with minimal privileges so the GRANT/REVOKE statements succeed.
psql "$DB_URL" -c "
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      -- Non-superuser role for integration tests. Tests SET LOCAL ROLE
      -- app_user inside each transaction so RLS / FORCE RLS actually
      -- evaluate (the default 'postgres' superuser BYPASSes RLS).
      CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user';
    END IF;
  END \$\$;
" >/dev/null

echo "→ Creating _migrations tracker"
psql "$DB_URL" -c "
  CREATE TABLE IF NOT EXISTS _migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
" >/dev/null

for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  basename=$(basename "$f")
  # Skip the temp regression test fixtures.
  if [[ "$basename" =~ ^_ ]]; then continue; fi
  applied=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM _migrations WHERE filename='$basename'")
  if [ "$applied" = "0" ]; then
    echo "→ Applying $basename"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
    psql "$DB_URL" -c "INSERT INTO _migrations (filename) VALUES ('$basename')" >/dev/null
  fi
done

SEED="$ROOT/src/__tests__/integration/seed.sql"
if [ -f "$SEED" ]; then
  echo "→ Applying seed.sql"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null
fi

echo "→ Granting app_user access to schema + tables"
# Tests SET LOCAL ROLE app_user to exercise RLS. Give it the minimum
# rights to read + write every public table + functions.
psql "$DB_URL" -c "
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
" >/dev/null

echo "✓ Docker DB ready at $DB_URL"
