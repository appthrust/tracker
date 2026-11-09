#!/usr/bin/env bash
# Requires Go, curl, jq, psql and Python 3. Uses an isolated, disposable DB schema.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to a local disposable Postgres database}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
schema="tracker_smoke_$(date +%s)_$$"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null
  rm -rf -- "$work"
}
trap cleanup EXIT
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
PLATFORM_OIDC_ISSUER= PLATFORM_OIDC_ISSUER_CA_PEM= PLATFORM_ACCESS_ISSUER= \
  PLATFORM_API_URL=http://127.0.0.1:1 PLATFORM_PROJECT_ID=pj-smoke \
  TRACKER_PUBLIC_URL= TRACKER_DIRECTORY_URL= TRACKER_DIRECTORY_PUBLIC_URL= \
  TRACKER_DATABASE_URL="$scoped_dsn" TRACKER_DEV_SEED=1 \
  "$work/tracker-server" --listen "127.0.0.1:$port" --static-dir "$work" >"$work/server.log" 2>&1 &
server_pid=$!
base="http://127.0.0.1:$port/api/tracker/v1"
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$work/server.log"; exit 1; fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then cat "$work/server.log"; echo 'Server did not become ready' >&2; exit 1; fi
token=$(python3 - <<'PY'
import base64, json
def enc(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
print(enc({'alg':'none'})+'.'+enc({'sub':'dev-alex','name':'Alex Chen','email':'alex@example.test'})+'.')
PY
)
auth="Authorization: Bearer $token"
request() { curl -fsS -H "$auth" -H 'Content-Type: application/json' "$@"; }
request "$base/workspace" | jq -e '.key == "APT" and .issueCount == 30' >/dev/null
issue=$(request -X POST "$base/issues" --data '{"title":"Smoke bug","type":"bug","report":{"environment":"local","surface":"apth","steps":"Run smoke","expected":"Success","actual":"Under investigation"}}')
id=$(jq -er '.id' <<<"$issue")
jq -e '.identifier == "APT-31" and .report.environment == "local" and .reporter.sub == "dev-alex"' <<<"$issue" >/dev/null
request -X POST "$base/issues/$id/comments" --data '{"body":"Smoke comment"}' | jq -e '.body == "Smoke comment"' >/dev/null
printf 'Tracker smoke attachment\n' >"$work/note.txt"
attachment=$(curl -fsS -H "$auth" -F "file=@$work/note.txt;type=text/plain" "$base/issues/$id/attachments")
url=$(jq -er '.url' <<<"$attachment")
curl -fsS -H "$auth" "http://127.0.0.1:$port$url" -o "$work/download.txt"
cmp "$work/note.txt" "$work/download.txt"
status=$(request "$base/statuses" | jq -er '.items[] | select(.category == "completed") | .id')
request -X PATCH "$base/issues/$id" --data "{\"statusId\":\"$status\"}" | jq -e '.completedAt != null and .commentCount == 1 and .attachmentCount == 1' >/dev/null
request "$base/issues/$id/timeline" | jq -e '[.items[].kind] | (map(select(. == "comment")) | length) == 1' >/dev/null
request "$base/issues/$id/timeline" | jq -e '[.items[] | select(.kind == "activity") | .activity.field] | index("created") != null and index("attachment") != null and index("status") != null' >/dev/null
request --get "$base/issues" --data-urlencode 'filter={"type":["bug"],"q":"Smoke bug","environment":["local"],"category":["completed"]}' | jq -e --arg id "$id" '.items | length == 1 and .[0].id == $id' >/dev/null
printf 'Tracker smoke passed: create → comment → attachment → status → timeline → filtered list\n'
