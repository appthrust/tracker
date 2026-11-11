"""Real HTTP assertions for the collaboration protocol; invoked by agents-smoke.sh."""
import concurrent.futures
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

base = sys.argv[1]
with open(sys.argv[2], encoding="utf-8") as source:
    tokens = json.load(source)
cursor = 0
observed = []
step = "initialization"


def raw(who, method, path, body=None, key=None):
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Authorization": "Bearer " + tokens[who], "Content-Type": "application/json"}
    if key is not None:
        headers["Idempotency-Key"] = key
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def check_events(expected):
    """Drain every page after every operation, even reads/refusals; never skip a cursor."""
    global cursor
    batch = []
    while True:
        code, data, _ = raw("person", "GET", f"/events?after={cursor}&limit=2")
        assert code == 200, data
        page = json.loads(data)
        for event in page["items"]:
            assert event["seq"] == cursor + 1, (cursor, event)
            assert event["actor"]["kind"] in ["person", "agent"]
            assert event["issue"] is not None
            if event["type"] == "issue.updated":
                assert event["data"]["fields"] and len(event["data"]["fields"]) == len(set(event["data"]["fields"]))
            else:
                assert isinstance(event["data"], str) and len(event["data"]) == 26
            cursor = event["seq"]
            batch.append(event)
        assert page["next"] == cursor
        if len(page["items"]) < 2:
            break
    assert [e["type"] for e in batch] == expected, (step, expected, batch)
    observed.extend(batch)
    return batch


def call(who, method, path, body=None, expected=200, events=None, key=None, drain=True):
    code, data, _ = raw(who, method, path, body, key)
    value = json.loads(data) if data else None
    if expected is not None:
        assert code == expected, f"{method} {path}: {code} {value}, expected {expected}"
    if drain:
        types = [] if events is None else events
        if events is None and code < 300:
            if method == "POST" and path == "/issues":
                types = ["issue.created"]
            elif method == "PATCH" and re.fullmatch(r"/issues/[^/]+", path):
                types = ["issue.updated"]
            elif method == "DELETE" and re.fullmatch(r"/issues/[^/]+", path):
                types = ["issue.deleted"]
            elif method == "POST":
                for pattern, kind in [
                    (r"/issues/[^/]+/comments", "comment.created"),
                    (r"/issues/[^/]+/runs", "run.started"),
                    (r"/issues/[^/]+/requests", "request.opened"),
                    (r"/requests/[^/]+/answer", "request.answered"),
                    (r"/requests/[^/]+/withdraw", "request.withdrawn"),
                    (r"/runs/[^/]+/cancel", "run.canceled"),
                    (r"/runs/[^/]+/finish", "run.finished"),
                ]:
                    if re.fullmatch(pattern, path):
                        types = [kind]
        emitted = check_events(types)
        if len(emitted) == 1 and emitted[0]["type"] != "issue.updated" and isinstance(value, dict) and "id" in value:
            assert emitted[0]["data"] == value["id"]
    return value if expected is not None else (code, value)


def issue(who="person", **fields):
    return call(who, "POST", "/issues", {"title": "Delegated smoke work", "type": "task", **fields}, 201)


def inbox(who):
    return call(who, "GET", "/inbox")["items"]


def ok():
    print("ok: " + step, flush=True)


try:
    step = "unregistered key, immutable handle identity and scope projection"
    assert call("astra", "GET", "/me", expected=403)["error"] == "key_subject"
    origin = call("person", "GET", "/events")
    assert origin == {"items": [], "next": 0}
    agents = {}
    for handle in ["astra", "other"]:
        agents[handle] = call("person", "POST", "/agents", {"handle": handle, "name": handle.title(), "ownerSub": "smoke-person"}, 201)
    me = call("astra", "GET", "/me")
    sub = "agent:" + agents["astra"]["id"]
    other = "agent:" + agents["other"]["id"]
    assert me["kind"] == "agent" and me["sub"] == sub and me["name"] == "Astra"
    assert me["agent"]["handle"] == "astra" and me["agent"]["owner"]["sub"] == "smoke-person"
    assert me["scopes"] == ["tracker:read", "tracker:write"] and not me["isAdmin"]
    call("astra", "POST", "/agents", {}, 403)
    call("person", "PATCH", "/agents/" + agents["astra"]["id"], {"handle": "renamed"}, 400)
    ok()

    step = "idempotent create, reported self-assignment and conditional edits"
    payload = {"title": "Exactly once", "type": "task"}
    created = call("astra", "POST", "/issues", payload, 201, key="issue-once")
    assert created["reporter"]["sub"] == sub
    replay = call("astra", "POST", "/issues", payload, 201, events=[], key="issue-once")
    assert replay == created
    call("astra", "POST", "/issues", {**payload, "title": "Different"}, 409, key="issue-once")
    updated = call("astra", "PATCH", "/issues/" + created["id"], {"assigneeSub": sub, "expectedUpdatedAt": created["updatedAt"]})
    assert updated["delegator"]["sub"] == "smoke-person"
    call("astra", "PATCH", "/issues/" + created["id"], {"title": "Stale", "expectedUpdatedAt": created["updatedAt"]}, 409)
    unrelated = issue(title="Unrelated")
    call("astra", "PATCH", "/issues/" + unrelated["id"], {"assigneeSub": sub}, 403)
    ok()

    step = "person delegates Backlog; only the assignee starts; one concurrent winner"
    statuses = call("person", "GET", "/statuses")["items"]
    completed = next(s["id"] for s in statuses if s["category"] == "completed")
    assigned = issue(title="Clean up fixtures")
    assigned = call("person", "PATCH", "/issues/" + assigned["id"], {"assigneeSub": sub})
    iid = assigned["id"]
    assert any(i["kind"] == "assignment" and i["issue"]["id"] == iid for i in inbox("astra"))
    call("other", "POST", "/issues/" + iid + "/runs", {}, 403)
    run = call("astra", "POST", "/issues/" + iid + "/runs", {"session": "smoke-main"}, 201)
    rid = run["id"]
    call("astra", "POST", "/issues/" + iid + "/runs", {}, 409)
    fresh = issue(assigneeSub=sub)
    def start(_):
        return call("astra", "POST", "/issues/" + fresh["id"] + "/runs", {}, None, drain=False)[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(start, range(2))) == [201, 409]
    check_events(["run.started"])
    ok()

    step = "heartbeat, question waiting, person answer, four-kind inbox and mention ack"
    heartbeat = call("astra", "POST", "/runs/" + rid + "/heartbeat", {"note": "Investigating with the person"})
    assert heartbeat["state"] == "running"
    question = call("astra", "POST", "/issues/" + iid + "/requests", {"kind": "question", "title": "Which approach?", "options": ["small", "large"], "runId": rid}, 201)
    assert question["to"]["sub"] == "smoke-person"
    assert call("person", "GET", "/runs/" + rid)["state"] == "waiting"
    call("person", "POST", "/requests/" + question["id"] + "/answer", {"option": "invalid"}, 400)
    call("person", "POST", "/requests/" + question["id"] + "/answer", {"option": "small", "body": "Keep it small"})
    assert call("astra", "GET", "/runs/" + rid)["state"] == "running"
    incoming = call("person", "POST", "/issues/" + unrelated["id"] + "/requests", {"kind": "question", "title": "Can you explain the cache?", "to": sub}, 201)
    mention = call("person", "POST", "/issues/" + unrelated["id"] + "/comments", {"body": "@astra please check this too. @astra"}, 201)
    assert len(mention["mentions"]) == 1 and mention["mentions"][0]["agent"]["id"] == agents["astra"]["id"]
    agent_inbox = call("astra", "GET", "/inbox")
    assert {i["kind"] for i in agent_inbox["items"]} == {"request", "answer", "mention", "assignment"}
    assert agent_inbox["items"][0]["kind"] == "request"
    agent_json = next(a for a in call("astra", "GET", "/agents")["items"] if a["handle"] == "astra")
    issue_row = next(i for i in call("astra", "GET", "/issues")["items"] if i["id"] == iid)
    assert issue_row["activeRun"]["id"] == rid and issue_row["assignee"]["agent"]["handle"] == "astra"
    call("astra", "POST", "/inbox/ack", {"answers": [question["id"]], "mentions": [mention["id"]]}, 204)
    assert not any(i["kind"] in ["answer", "mention"] for i in inbox("astra"))
    call("astra", "POST", "/requests/" + incoming["id"] + "/answer", {"body": "It is a stale cache."})
    ok()

    step = "explicit null targets any person; successful finish requires approvals resolved"
    approval = call("astra", "POST", "/issues/" + iid + "/requests", {"kind": "approval", "title": "Proceed?", "to": None, "runId": rid}, 201)
    assert approval["to"] is None and approval["options"] == ["approve", "reject"]
    call("astra", "POST", "/runs/" + rid + "/finish", {"outcome": "succeeded", "summary": "Ready"}, 409)
    call("astra", "POST", "/requests/" + approval["id"] + "/answer", {"option": "approve"}, 403)
    call("astra", "POST", "/requests/" + approval["id"] + "/withdraw")
    call("astra", "PATCH", "/issues/" + iid, {"statusId": completed}, 403)
    obsolete = call("astra", "POST", "/issues/" + iid + "/requests", {"kind": "question", "title": "No longer needed", "runId": rid}, 201)
    call("astra", "POST", "/runs/" + rid + "/finish", {"outcome": "succeeded", "summary": "Ready for your review", "links": [{"kind": "pr", "url": "https://example.test/pull/1", "title": "Reviewed change"}]}, events=["run.finished", "request.withdrawn", "request.opened"])
    assert call("astra", "GET", "/requests/" + obsolete["id"])["state"] == "withdrawn"
    review = next(i["request"] for i in inbox("person") if i["kind"] == "request" and i["request"]["kind"] == "review")
    assert review["title"] == "Review: Clean up fixtures" and review["body"] == "Ready for your review"
    call("astra", "POST", "/requests/" + review["id"] + "/answer", {"option": "approve"}, 403)
    call("person", "POST", "/requests/" + review["id"] + "/answer", {"option": "approve"}, events=["issue.updated", "request.answered"])
    done = call("person", "GET", "/issues/" + iid)
    assert done["statusId"] == completed and done["completedAt"] is not None
    timeline = call("person", "GET", "/issues/" + iid + "/timeline")["items"]
    assert {i["kind"] for i in timeline} >= {"activity", "run", "request"}
    changes = [i["activity"] for i in timeline if i["kind"] == "activity" and i["activity"]["field"] == "status"]
    assert changes[-1]["actor"]["sub"] == "smoke-person"
    call("astra", "POST", "/runs/" + rid + "/heartbeat", {}, 409)
    ok()

    step = "expired lease cannot revive, stale requests do not hide recovery assignment"
    expiring = issue(assigneeSub=sub)
    expired = call("astra", "POST", "/issues/" + expiring["id"] + "/runs", {}, 201)
    pending = call("astra", "POST", "/issues/" + expiring["id"] + "/requests", {"kind": "question", "title": "Waiting before expiry", "runId": expired["id"]}, 201)
    deadline = time.monotonic() + 12
    while call("person", "GET", "/runs/" + expired["id"])["state"] != "stalled":
        assert time.monotonic() < deadline, "short lease did not expire"
        time.sleep(0.1)
    for action, body in [("heartbeat", {}), ("finish", {"outcome": "failed", "summary": "Too late"})]:
        call("astra", "POST", "/runs/" + expired["id"] + "/" + action, body, 409)
    assert any(i["kind"] == "assignment" and i["issue"]["id"] == expiring["id"] for i in inbox("astra"))
    replacement = call("astra", "POST", "/issues/" + expiring["id"] + "/runs", {}, 201, events=["run.finished", "request.withdrawn", "run.started"])
    assert call("person", "GET", "/runs/" + expired["id"])["reason"] == "lease_expired"
    assert call("person", "GET", "/requests/" + pending["id"])["state"] == "withdrawn"
    call("person", "POST", "/runs/" + replacement["id"] + "/cancel")
    ok()

    step = "reassignment and disabling atomically cancel runs and withdraw requests"
    moving = issue(assigneeSub=other)
    original = call("other", "POST", "/issues/" + moving["id"] + "/runs", {}, 201)
    pending = call("other", "POST", "/issues/" + moving["id"] + "/requests", {"kind": "question", "title": "Reassign?", "runId": original["id"]}, 201)
    call("person", "PATCH", "/issues/" + moving["id"], {"assigneeSub": sub}, events=["run.canceled", "request.withdrawn", "issue.updated"])
    old = call("person", "GET", "/runs/" + original["id"])
    assert old["state"] == "canceled" and old["reason"] == "reassigned"
    disabled_issue = issue(assigneeSub=other)
    disabled_run = call("other", "POST", "/issues/" + disabled_issue["id"] + "/runs", {}, 201)
    call("other", "POST", "/issues/" + disabled_issue["id"] + "/requests", {"kind": "question", "title": "Attached", "runId": disabled_run["id"]}, 201)
    standalone = call("other", "POST", "/issues/" + disabled_issue["id"] + "/requests", {"kind": "question", "title": "Standalone"}, 201)
    call("person", "PATCH", "/agents/" + agents["other"]["id"], {"disabled": True}, events=["run.canceled", "request.withdrawn", "request.withdrawn"])
    assert call("other", "GET", "/me", expected=403)["error"] == "key_subject"
    assert call("person", "GET", "/runs/" + disabled_run["id"])["state"] == "canceled"
    assert call("person", "GET", "/requests/" + standalone["id"])["state"] == "withdrawn"
    call("person", "PATCH", "/issues/" + disabled_issue["id"], {"assigneeSub": other}, 400)
    assert len(call("person", "GET", "/agents")["items"]) == 1
    assert len(call("person", "GET", "/agents?includeDisabled=true")["items"]) == 2
    ok()

    step = "direct policy, unchanged user-key authority, deletion and agent guide"
    direct = issue(assigneeSub=sub)
    call("person", "PATCH", "/workspace", {"agentCompletion": "direct"})
    call("astra", "PATCH", "/issues/" + direct["id"], {"statusId": completed})
    user = call("smoke-person", "GET", "/me")
    assert user["sub"] == "smoke-person" and user["name"] == "Smoke Person" and not user["isAdmin"]
    assert issue("smoke-person")["reporter"]["kind"] == "person"
    call("smoke-person", "PATCH", "/workspace", {"agentCompletion": "review"}, 403)
    call("person", "DELETE", "/issues/" + direct["id"], expected=204)
    code, guide, headers = raw("astra", "GET", "/agent-guide")
    assert code == 200 and headers["Content-Type"].startswith("text/markdown")
    assert b"POST /runs/{id}/heartbeat" in guide and b"Idempotency-Key" in guide
    check_events([])
    latest = call("person", "GET", "/events")
    assert latest == {"items": [], "next": cursor}
    event_page = call("person", "GET", "/events?after=0&limit=5")
    assert [e["seq"] for e in observed] == list(range(1, cursor + 1))
    ok()
    print(f"ok: {cursor} events delivered exactly once in order without gaps across the entire script", flush=True)
    for label, value in [("agent", agent_json), ("issue-list-row", issue_row), ("event-page", event_page), ("agent-inbox", agent_inbox)]:
        print("JSON " + label + ": " + json.dumps(value, separators=(",", ":")), flush=True)
except Exception as error:
    print("FAIL: " + step + ": " + str(error), file=sys.stderr, flush=True)
    raise
