#!/usr/bin/env bash
# Requires Go, curl, jq, psql and Python 3. Uses an isolated, disposable DB schema.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to a local disposable Postgres database}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
schema="tracker_smoke_$(date +%s)_$$"
server_pid=""
platform_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$platform_pid" ]]; then kill "$platform_pid" 2>/dev/null || true; wait "$platform_pid" 2>/dev/null || true; fi
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
# Serve only this disposable installation's role lookup for Admin-only operations.
python3 - "$work/platform-port" <<'PY' >"$work/platform.log" 2>&1 &
import http.server, json, pathlib, sys
class Platform(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/api/v1/projects/pj-smoke/access' or not self.headers.get('Authorization', '').startswith('Bearer '):
            self.send_error(404)
            return
        body = json.dumps({'projectId': 'pj-smoke', 'member': True, 'role': 'Admin'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
with http.server.HTTPServer(('127.0.0.1', 0), Platform) as server:
    pathlib.Path(sys.argv[1]).write_text(str(server.server_port))
    server.serve_forever()
PY
platform_pid=$!
for ((attempt=0; attempt<50; attempt++)); do
  if [[ -s "$work/platform-port" ]]; then break; fi
  if ! kill -0 "$platform_pid" 2>/dev/null; then cat "$work/platform.log"; exit 1; fi
  sleep 0.1
done
if [[ ! -s "$work/platform-port" ]]; then cat "$work/platform.log"; echo 'Platform fixture did not become ready' >&2; exit 1; fi
platform_port=$(cat "$work/platform-port")
PLATFORM_OIDC_ISSUER= PLATFORM_OIDC_ISSUER_CA_PEM= PLATFORM_ACCESS_ISSUER= \
  PLATFORM_API_URL="http://127.0.0.1:$platform_port" PLATFORM_PROJECT_ID=pj-smoke \
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
print(enc({'alg':'none'})+'.'+enc({'sub':'smoke-reporter','name':'Smoke Reporter','email':'smoke@example.test'})+'.')
PY
)
auth="Authorization: Bearer $token"
request() { curl -fsS -H "$auth" -H 'Content-Type: application/json' "$@"; }
request "$base/workspace" | jq -e '.key == "APT" and .issueCount == 30' >/dev/null
project=$(request -X POST "$base/projects" --data '{"name":"Smoke project","color":"blue"}')
project_id=$(jq -er '.id' <<<"$project")
issue=$(request -X POST "$base/issues" --data "{\"title\":\"Smoke bug\",\"type\":\"bug\",\"projectId\":\"$project_id\",\"report\":{\"environment\":\"local\",\"surface\":\"apth\",\"steps\":\"Run smoke\",\"expected\":\"Success\",\"actual\":\"Under investigation\"}}")
id=$(jq -er '.id' <<<"$issue")
jq -e '.identifier == "APT-31" and .report.environment == "local" and .reporter.sub == "smoke-reporter"' <<<"$issue" >/dev/null
jq -e --arg project "$project_id" '.projectId == $project' <<<"$issue" >/dev/null
request --get "$base/issues" --data-urlencode "filter={\"project\":[\"$project_id\"]}" | jq -e --arg id "$id" --arg project "$project_id" '.items | length == 1 and .[0].id == $id and .[0].projectId == $project' >/dev/null
request --get "$base/issues" --data-urlencode 'filter={"reporter":["me"]}' | jq -e --arg id "$id" '.items | length == 1 and .[0].id == $id and .[0].reporter.sub == "smoke-reporter"' >/dev/null
code=$(curl -sS -o "$work/invalid-reporter.json" -w '%{http_code}' -H "$auth" --get "$base/issues" --data-urlencode 'filter={"reporter":[""]}')
[[ "$code" == 400 ]]
jq -e '.error == "invalid" and .issues[0].path == "filter.reporter"' "$work/invalid-reporter.json" >/dev/null
code=$(curl -sS -o "$work/conflict.json" -w '%{http_code}' -H "$auth" -X DELETE "$base/projects/$project_id")
[[ "$code" == 409 ]]
jq -e '.error == "conflict"' "$work/conflict.json" >/dev/null
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
request -X PATCH "$base/issues/$id" --data '{"projectId":null}' | jq -e 'has("projectId") and .projectId == null' >/dev/null
request --get "$base/issues" --data-urlencode "filter={\"project\":[\"$project_id\"]}" | jq -e '.items | length == 0' >/dev/null
request --get "$base/issues" --data-urlencode 'filter={"project":["none"],"q":"Smoke bug"}' | jq -e --arg id "$id" '.items | length == 1 and .[0].id == $id and .[0].projectId == null' >/dev/null
request "$base/issues/$id/timeline" | jq -e --arg project "$project_id" '[.items[] | select(.kind == "activity" and .activity.field == "project") | .activity] | length == 1 and .[0].from == $project and .[0].to == null' >/dev/null
code=$(curl -sS -o "$work/deleted" -w '%{http_code}' -H "$auth" -X DELETE "$base/projects/$project_id")
[[ "$code" == 204 && ! -s "$work/deleted" ]]
printf 'Tracker smoke passed: project → issue → reporter filter → invalid reporter → referenced delete conflict → comment → attachment → status → timeline → project filter → no project → project delete\n'
