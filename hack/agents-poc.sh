#!/usr/bin/env bash
# Development-only proof, not release authority. Requires Go, Python 3, curl, jq,
# and psql. Like smoke.sh, isolates all writes in a disposable Postgres schema.
# Expired runs cannot heartbeat/finish: 409; next start closes failed/lease_expired.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to local disposable Postgres}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
schema="tracker_agents_poc_$(date +%s)_$$"
server_pid=""
fixture_pid=""
step="setup"
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'echo "FAIL: $step" >&2; if [[ -f "$work/server.log" ]]; then cat "$work/server.log" >&2; fi' ERR
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
go build -o "$work/fixture" ./cmd/server/internal/poctestutil
"$work/fixture" --output "$work/tokens.json" >"$work/fixture.log" 2>&1 &
fixture_pid=$!
for ((attempt=0; attempt<50; attempt++)); do
  if [[ -s "$work/tokens.json" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$work/fixture.log"; echo 'FAIL: assertion fixture startup' >&2; exit 1; fi
  sleep 0.1
done
[[ -s "$work/tokens.json" ]]
origin=$(jq -er .origin "$work/tokens.json")
issuer=$(jq -er .issuer "$work/tokens.json")
PLATFORM_OIDC_ISSUER= PLATFORM_OIDC_ISSUER_CA_PEM= PLATFORM_ACCESS_ISSUER="$issuer" \
  TRACKER_ACCESS_AUDIENCE=tracker PLATFORM_API_URL="$origin" PLATFORM_PROJECT_ID=pj-agents-poc \
  TRACKER_PUBLIC_URL= TRACKER_DIRECTORY_URL= TRACKER_DIRECTORY_PUBLIC_URL= \
  TRACKER_DATABASE_URL="$scoped_dsn" TRACKER_DEV_SEED=0 TRACKER_RUN_LEASE=5s \
  "$work/tracker-server" --listen "127.0.0.1:$port" --static-dir "$work" >"$work/server.log" 2>&1 &
server_pid=$!
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$work/server.log"; echo 'FAIL: server startup' >&2; exit 1; fi
  sleep 0.25
done
[[ "$ready" == 1 ]]
step="real server collaboration assertions"
python3 - "http://127.0.0.1:$port/api/tracker/v1" "$work/tokens.json" <<'PY'
import concurrent.futures, json, sys, time, urllib.error, urllib.request
base = sys.argv[1]
with open(sys.argv[2]) as f:
    tokens = json.load(f)
step = 'initialization'
def call(who, method, path, body=None, expected=200):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + tokens[who], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            code, raw = response.status, response.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    value = json.loads(raw) if raw else None
    if expected is not None:
        assert code == expected, f'{method} {path}: {code} {value}, expected {expected}'
    return value if expected is not None else (code, value)
def ok():
    print('ok: ' + step, flush=True)
def issue(who='person', **fields):
    return call(who, 'POST', '/issues', {'title':'Delegated PoC work', 'type':'task', **fields}, 201)
def inbox(who):
    return call(who, 'GET', '/inbox')['items']
try:
    step = 'a. unregistered external key is refused with key_subject'
    assert call('poc-astra', 'GET', '/me', expected=403)['error'] == 'key_subject'
    ok()
    step = 'b. person registers two agents; agent me has kind, handle and owner'
    agents = {}
    for handle in ['astra', 'other']:
        agents[handle] = call('person', 'POST', '/agents', {'handle':handle, 'name':handle.title(), 'keySubject':'poc-'+handle, 'ownerSub':'poc-person'}, 201)
    me = call('poc-astra', 'GET', '/me')
    sub = 'agent:' + agents['astra']['id']
    assert me['kind'] == 'agent' and me['sub'] == sub and me['name'] == 'Astra'
    assert me['agent']['handle'] == 'astra' and me['agent']['owner']['sub'] == 'poc-person'
    assert not me['isAdmin'] and me['role'] == 'Viewer'
    listed = call('poc-astra', 'GET', '/agents')['items']
    assert len(listed) == 2 and all(a['owner']['kind'] == 'person' for a in listed)
    assert call('poc-astra', 'POST', '/agents', {}, 403)['error'] == 'forbidden'
    ok()
    step = 'c. agent-created issue reports the agent, not the owner'
    created = issue('poc-astra')
    assert created['reporter']['sub'] == sub and created['reporter']['kind'] == 'agent'
    ok()
    step = 'd. person assignment records delegator and appears in agent inbox'
    statuses = call('person', 'GET', '/statuses')['items']
    unstarted = next(s['id'] for s in statuses if s['category'] == 'unstarted')
    completed = next(s['id'] for s in statuses if s['category'] == 'completed')
    assigned = issue(statusId=unstarted)
    assigned = call('person', 'PATCH', '/issues/'+assigned['id'], {'assigneeSub':sub})
    iid = assigned['id']
    assert assigned['delegator']['sub'] == 'poc-person' and assigned['delegator']['kind'] == 'person'
    assert any(x['kind'] == 'assignment' and x['issue']['id'] == iid for x in inbox('poc-astra'))
    ok()
    step = 'e. wrong agent forbidden; exclusive run lease and concurrent start winner'
    call('poc-other', 'POST', '/issues/'+iid+'/runs', {}, 403)
    run = call('poc-astra', 'POST', '/issues/'+iid+'/runs', {'session':'poc-main'}, 201)
    rid = run['id']
    call('poc-astra', 'POST', '/issues/'+iid+'/runs', {}, 409)
    fresh = issue(statusId=unstarted, assigneeSub=sub)
    def start(_):
        return call('poc-astra', 'POST', '/issues/'+fresh['id']+'/runs', {}, None)[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(start, range(2))) == [201, 409]
    ok()
    step = 'f. heartbeat note and issue activeRun are running'
    heartbeat = call('poc-astra', 'POST', '/runs/'+rid+'/heartbeat', {'note':'Investigating with the person'})
    assert heartbeat['state'] == 'running' and heartbeat['note'] == 'Investigating with the person'
    active_issue = call('poc-astra', 'GET', '/issues/'+iid)
    assert active_issue['activeRun']['id'] == rid and active_issue['activeRun']['state'] == 'running'
    ok()
    step = 'g. question waits; person answers; run resumes and agent receives answer'
    question = call('poc-astra', 'POST', '/issues/'+iid+'/requests', {'kind':'question', 'title':'Which approach?', 'options':['small','large'], 'runId':rid}, 201)
    assert question['to']['sub'] == 'poc-person'
    assert call('person', 'GET', '/issues/'+iid)['activeRun']['state'] == 'waiting'
    assert any(x['kind'] == 'request' and x['request']['id'] == question['id'] for x in inbox('person'))
    call('person', 'POST', '/requests/'+question['id']+'/answer', {'option':'invalid'}, 400)
    answered = call('person', 'POST', '/requests/'+question['id']+'/answer', {'option':'small', 'body':'Keep it small'})
    assert answered['state'] == 'answered'
    assert call('poc-astra', 'GET', '/issues/'+iid)['activeRun']['state'] == 'running'
    agent_inbox = call('poc-astra', 'GET', '/inbox')
    assert any(x['kind'] == 'answer' and x['request']['id'] == question['id'] for x in agent_inbox['items'])
    ok()
    step = 'h. agent cannot complete or review; person approval completes with person activity'
    call('poc-astra', 'PATCH', '/issues/'+iid, {'statusId':completed}, 403)
    finished = call('poc-astra', 'POST', '/runs/'+rid+'/finish', {'outcome':'succeeded','summary':'Ready for your review','links':[{'kind':'pr','url':'https://example.test/pull/1','title':'PoC change'}]})
    assert finished['state'] == 'succeeded'
    review = next(x['request'] for x in inbox('person') if x['kind'] == 'request' and x['request']['kind'] == 'review' and x['request']['issue']['id'] == iid)
    assert review['to']['sub'] == 'poc-person' and review['options'] == ['approve','reject']
    call('poc-astra', 'POST', '/requests/'+review['id']+'/answer', {'option':'approve'}, 403)
    approved = call('person', 'POST', '/requests/'+review['id']+'/answer', {'option':'approve'})
    done = call('person', 'GET', '/issues/'+iid)
    assert approved['answer']['by']['sub'] == 'poc-person'
    assert done['statusId'] == completed and done['completedAt'] is not None
    timeline = call('person', 'GET', '/issues/'+iid+'/timeline')['items']
    changes = [x['activity'] for x in timeline if x['kind'] == 'activity' and x['activity']['field'] == 'status']
    assert changes[-1]['actor']['sub'] == 'poc-person' and changes[-1]['actor']['kind'] == 'person'
    call('poc-astra', 'POST', '/runs/'+rid+'/heartbeat', {}, 409)
    ok()
    step = 'i. stalled lease stays in inbox, cannot heartbeat, and next start closes lease_expired'
    expiring = issue(statusId=unstarted, assigneeSub=sub)
    expired = call('poc-astra', 'POST', '/issues/'+expiring['id']+'/runs', {}, 201)
    expired_question = call('poc-astra', 'POST', '/issues/'+expiring['id']+'/requests', {'kind':'question','title':'Waiting before expiry','runId':expired['id']}, 201)
    assert not any(x['kind'] == 'assignment' and x['issue']['id'] == expiring['id'] for x in inbox('poc-astra'))
    deadline = time.monotonic() + 12
    while True:
        current = call('person', 'GET', '/issues/'+expiring['id'])
        if current['activeRun']['state'] == 'stalled': break
        assert time.monotonic() < deadline, 'short lease did not expire'
        time.sleep(0.1)
    call('poc-astra', 'POST', '/runs/'+expired['id']+'/heartbeat', {}, 409)
    assert any(x['kind'] == 'assignment' and x['issue']['id'] == expiring['id'] for x in inbox('poc-astra'))
    restarted = call('poc-astra', 'POST', '/issues/'+expiring['id']+'/runs', {}, 201)
    history = call('person', 'GET', '/issues/'+expiring['id']+'/runs')['items']
    old = next(r for r in history if r['id'] == expired['id'])
    assert old['state'] == 'failed' and old['reason'] == 'lease_expired' and old['finishedAt'] is not None
    assert not any(x['kind'] == 'request' and x['request']['id'] == expired_question['id'] for x in inbox('person'))
    assert restarted['id'] != expired['id'] and restarted['state'] == 'running'
    ok()
    step = 'j. user-subject key still acts as that person, never as Admin'
    user = call('poc-person', 'GET', '/me')
    assert user['sub'] == 'poc-person' and user['kind'] == 'person' and user['name'] == 'PoC Person'
    assert user['role'] == 'Viewer' and not user['isAdmin']
    from_user = issue('poc-person')
    assert from_user['reporter']['sub'] == 'poc-person' and from_user['reporter']['kind'] == 'person'
    call('poc-person', 'POST', '/agents', {}, 403)
    ok()
    step = 'k. reassignment cancels the old run, withdraws its requests, and frees the new assignee'
    moving = issue(statusId=unstarted, assigneeSub=sub)
    original = call('poc-astra', 'POST', '/issues/'+moving['id']+'/runs', {}, 201)
    call('person', 'PATCH', '/issues/'+moving['id'], {'assigneeSub':'agent:'+agents['other']['id']})
    old = next(r for r in call('person', 'GET', '/issues/'+moving['id']+'/runs')['items'] if r['id'] == original['id'])
    assert old['state'] == 'canceled' and old['reason'] == 'reassigned'
    replacement = call('poc-other', 'POST', '/issues/'+moving['id']+'/runs', {}, 201)
    pending = call('poc-other', 'POST', '/issues/'+moving['id']+'/requests', {'kind':'question','title':'Still needed?','runId':replacement['id']}, 201)
    call('person', 'PATCH', '/issues/'+moving['id'], {'assigneeSub':sub})
    assert not any(x['kind'] == 'request' and x['request']['id'] == pending['id'] for x in inbox('person'))
    call('person', 'POST', '/requests/'+pending['id']+'/answer', {'body':'Too late'}, 409)
    history = call('person', 'GET', '/issues/'+moving['id']+'/runs')['items']
    assert all(r['state'] == 'canceled' and r['reason'] == 'reassigned' for r in history)
    call('poc-astra', 'POST', '/issues/'+moving['id']+'/runs', {}, 201)
    ok()
    for label, value in [('agent-me', me), ('issue-active-run', active_issue), ('request', question), ('agent-inbox', agent_inbox)]:
        print('JSON ' + label + ': ' + json.dumps(value, separators=(',',':')), flush=True)
except Exception as error:
    print('FAIL: ' + step + ': ' + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
PY
