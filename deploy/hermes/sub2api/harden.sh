#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_dir="${1:-/opt/sub2api}"
compose_file="${deploy_dir}/docker-compose.local.yml"
override_file="${deploy_dir}/docker-compose.hardening.yml"
env_file="${deploy_dir}/.env"

for required in "${compose_file}" "${override_file}" "${env_file}"; do
  if [[ ! -f "${required}" ]]; then
    printf 'missing required file: %s\n' "${required}" >&2
    exit 2
  fi
done

if ! grep -Eq '^REDIS_PASSWORD=[^[:space:]]{32,}$' "${env_file}" \
  || grep -Eiq '^REDIS_PASSWORD=(replace[-_ ]?with|change[-_ ]?me|changeme|your[-_ ]?(password|secret|token))' "${env_file}"; then
  redis_password="$(openssl rand -hex 32)"
  temporary_env="$(mktemp "${deploy_dir}/.env.tmp.XXXXXX")"
  chmod 600 "${temporary_env}"

  if grep -q '^REDIS_PASSWORD=' "${env_file}"; then
    awk -v value="${redis_password}" '
      BEGIN { FS = OFS = "=" }
      $1 == "REDIS_PASSWORD" { print "REDIS_PASSWORD", value; next }
      { print }
    ' "${env_file}" > "${temporary_env}"
  else
    cp "${env_file}" "${temporary_env}"
    printf '\nREDIS_PASSWORD=%s\n' "${redis_password}" >> "${temporary_env}"
  fi

  install -m 600 -o root -g root "${temporary_env}" "${env_file}"
  rm -f "${temporary_env}"
  unset redis_password
fi

cd "${deploy_dir}"
docker compose -f "${compose_file}" -f "${override_file}" config --quiet
docker compose -f "${compose_file}" -f "${override_file}" up -d --force-recreate redis sub2api

redis_container="$(docker compose -f "${compose_file}" -f "${override_file}" ps -q redis)"
sub2api_container="$(docker compose -f "${compose_file}" -f "${override_file}" ps -q sub2api)"
if [[ -z "${redis_container}" || -z "${sub2api_container}" ]]; then
  printf 'unable to resolve Compose container ids\n' >&2
  exit 1
fi

for _attempt in $(seq 1 45); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:18080/health; then
    break
  fi
  sleep 2
done

curl --fail --silent --show-error http://127.0.0.1:18080/health

unauthenticated_response="$(
  docker exec "${redis_container}" env -u REDISCLI_AUTH redis-cli --raw ping 2>&1 || true
)"
if [[ "${unauthenticated_response}" != NOAUTH* ]]; then
  printf 'expected Redis to reject unauthenticated requests\n' >&2
  exit 1
fi

test "$(docker exec "${redis_container}" redis-cli --raw ping)" = "PONG"

for _attempt in $(seq 1 45); do
  if [[ "$(docker inspect "${sub2api_container}" --format '{{.State.Health.Status}}')" == "healthy" ]]; then
    break
  fi
  sleep 2
done

test "$(docker inspect "${sub2api_container}" --format '{{.State.Health.Status}}')" = "healthy"
docker compose -f "${compose_file}" -f "${override_file}" ps
