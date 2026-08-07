#!/usr/bin/env bash
set -euo pipefail

cd "${1:-/opt/account-api}"
set -a
source ./.env
set +a

docker compose exec -T account-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null <<'SQL'
\getenv postgres_user POSTGRES_USER
\getenv postgres_password POSTGRES_PASSWORD
ALTER USER :"postgres_user" WITH PASSWORD :'postgres_password';
SQL

export ACCOUNT_API_ADMIN_HASH="$(ADMIN_PASSWORD="$BOOTSTRAP_ADMIN_PASSWORD" node -e '
const crypto = require("node:crypto");
const salt = crypto.randomBytes(16).toString("hex");
process.stdout.write(`${salt}:${crypto.scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString("hex")}`);
')"

docker compose exec -T -e ACCOUNT_API_ADMIN_HASH account-postgres psql -v ON_ERROR_STOP=1 \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null <<'SQL'
\getenv admin_hash ACCOUNT_API_ADMIN_HASH
\getenv admin_email BOOTSTRAP_ADMIN_EMAIL
UPDATE users SET password_hash = :'admin_hash', updated_at = now() WHERE email = :'admin_email';
SQL
unset ACCOUNT_API_ADMIN_HASH

docker compose up -d --force-recreate account-api >/dev/null
