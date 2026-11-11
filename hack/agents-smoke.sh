#!/usr/bin/env bash
# Real-server collaboration contract, with disposable signed assertions and schema.
# Run through serialize-vm-tests; also invoked by hack/smoke.sh.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to local disposable Postgres}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
schema="tracker_agents_smoke_$(date +%s)_$$"
server_pid=""
fixture_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'if [[ -f "$work/server.log" ]]; then cat "$work/server.log" >&2; fi' ERR
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE SCHEMA $schema" >/dev/null
scoped_dsn=$(python3 - "$DATABASE_URL" "$schema" <<'PY'
import sys, urllib.parse
url = urllib.parse.urlsplit(sys.argv[1])
query = urllib.parse.parse_qs(url.query)
query['search_path'] = [sys.argv[2]]
print(urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query, doseq=True))))
PY
)
port=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
cd "$root"
go build -o "$work/tracker-server" ./cmd/server
go build -o "$work/fixture" ./cmd/server/internal/assertiontestutil
"$work/fixture" --output "$work/tokens.json" >"$work/fixture.log" 2>&1 &
fixture_pid=$!
for ((attempt=0; attempt<50; attempt++)); do
  if [[ -s "$work/tokens.json" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$work/fixture.log"; exit 1; fi
  sleep 0.1
done
[[ -s "$work/tokens.json" ]]
origin=$(jq -er .origin "$work/tokens.json")
issuer=$(jq -er .issuer "$work/tokens.json")
PLATFORM_OIDC_ISSUER= PLATFORM_OIDC_ISSUER_CA_PEM= PLATFORM_ACCESS_ISSUER="$issuer" \
  TRACKER_ACCESS_AUDIENCE=tracker PLATFORM_API_URL="$origin" PLATFORM_PROJECT_ID=pj-agents-smoke \
  TRACKER_PUBLIC_URL= TRACKER_DIRECTORY_URL= TRACKER_DIRECTORY_PUBLIC_URL= \
  TRACKER_DATABASE_URL="$scoped_dsn" TRACKER_DEV_SEED=0 TRACKER_RUN_LEASE=5s \
  "$work/tracker-server" --listen "127.0.0.1:$port" --static-dir "$work" >"$work/server.log" 2>&1 &
server_pid=$!
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$work/server.log"; exit 1; fi
  sleep 0.25
done
[[ "$ready" == 1 ]]
python3 hack/agents-smoke.py "http://127.0.0.1:$port/api/tracker/v1" "$work/tokens.json"
