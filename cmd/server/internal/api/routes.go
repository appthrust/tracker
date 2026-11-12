package api

import (
	"fmt"
	"strings"
)

type routeDefinition struct {
	pattern      string
	mutation     bool
	roles        bool
	handler      endpoint
	guide        string
	unregistered bool // External keys need not resolve to an active agent.
}

// This is the registration and agent-guide authority. Special binary/public
// handlers (Directory avatar and OpenAPI) are mounted separately.
func (a *API) routes() []routeDefinition {
	return []routeDefinition{
		{"GET /me", false, true, a.me, "Confirm your kind, agent handle, owner and scopes.", false},
		{"GET /workspace", false, false, a.workspaceGet, "Read the agentCompletion policy.", false},
		{"PATCH /workspace", true, true, a.workspacePatch, "", false},
		{"GET /statuses", false, false, a.statusList, "Read workflow status IDs and categories.", false},
		{"POST /statuses", true, true, a.statusCreate, "", false},
		{"PATCH /statuses/{id}", true, true, a.statusPatch, "", false},
		{"DELETE /statuses/{id}", true, true, a.statusDelete, "", false},
		{"PUT /statuses/order", true, true, a.statusOrder, "", false},
		{"GET /labels", false, false, a.labelList, "", false},
		{"POST /labels", true, true, a.labelCreate, "", false},
		{"PATCH /labels/{id}", true, true, a.labelPatch, "", false},
		{"DELETE /labels/{id}", true, true, a.labelDelete, "", false},
		{"GET /projects", false, false, a.projectList, "", false},
		{"POST /projects", true, false, a.projectCreate, "", false},
		{"GET /projects/{id}", false, false, a.projectGet, "", false},
		{"PATCH /projects/{id}", true, true, a.projectPatch, "", false},
		{"DELETE /projects/{id}", true, true, a.projectDelete, "", false},
		{"GET /sprints", false, false, a.sprintList, "", false},
		{"POST /sprints", true, false, a.sprintCreate, "", false},
		{"GET /sprints/{id}", false, false, a.sprintGet, "", false},
		{"PATCH /sprints/{id}", true, false, a.sprintPatch, "", false},
		{"POST /sprints/{id}/start", true, false, a.sprintStart, "", false},
		{"POST /sprints/{id}/close", true, false, a.sprintClose, "", false},
		{"DELETE /sprints/{id}", true, true, a.sprintDelete, "", false},
		{"GET /sprints/{id}/burndown", false, false, a.sprintBurndown, "", false},
		{"GET /velocity", false, false, a.velocity, "", false},
		{"GET /issues", false, false, a.issueList, "Filter issues; list rows include delegator, activeRun and openRequestCount.", false},
		{"POST /issues", true, false, a.issueCreate, "Create an issue; you are its reporter. You may assign it to yourself.", false},
		{"GET /issues/{id}", false, false, a.issueGet, "Read current fields, updatedAt and blocking issues before editing.", false},
		{"PATCH /issues/{id}", true, false, a.issuePatch, "Edit any issue's fields and move it among open statuses; changing the assignee, closing or reopening needs you to be assignee or reporter. Send expectedUpdatedAt to avoid overwriting changes.", false},
		{"DELETE /issues/{id}", true, true, a.issueDelete, "", false},
		{"GET /issues/{id}/timeline", false, false, a.timeline, "Read comments, activities, runs and requests.", false},
		{"POST /issues/{id}/comments", true, false, a.commentCreate, "Discuss any issue; @handle mentions a registered agent.", false},
		{"PATCH /comments/{id}", true, false, a.commentPatch, "Edit your own comment; mentions are reparsed.", false},
		{"DELETE /comments/{id}", true, true, a.commentDelete, "", false},
		{"POST /issues/{id}/attachments", true, false, a.attachmentCreate, "Attach evidence (multipart; excluded from idempotent replay).", false},
		{"GET /attachments/{id}", false, false, a.attachmentGet, "", false},
		{"DELETE /attachments/{id}", true, true, a.attachmentDelete, "", false},
		{"GET /views", false, false, a.viewList, "", false},
		{"POST /views", true, true, a.viewCreate, "", false},
		{"PATCH /views/{id}", true, true, a.viewPatch, "", false},
		{"DELETE /views/{id}", true, true, a.viewDelete, "", false},
		{"GET /people", false, false, a.people, "Keys cannot access Directory; returns an empty unavailable result.", false},
		{"GET /agents", false, false, a.agentList, "Discover agents; includeDisabled=true also returns retired identities.", false},
		{"POST /agents", true, true, a.agentCreate, "", false},
		{"POST /agents/register", true, false, a.agentRegister, "Register your own external handle with {name, description?, ownerSub}; 201 when new, 200 when already active.", true},
		{"PATCH /agents/{id}", true, true, a.agentPatch, "", false},
		{"GET /inbox", false, false, a.inbox, "Requests first, then answers, mentions and actionable assignments.", false},
		{"POST /inbox/ack", true, false, a.inboxAck, "Acknowledge {answers:[requestId], mentions:[commentId]} after handling them.", false},
		{"GET /events", false, false, a.events, "Initialize without after (empty items and current next); poll with after=next and limit 1–500.", false},
		{"POST /issues/{id}/runs", true, false, a.runStart, "Start only on your assigned issue with {session?,note?}; retain the returned run ID.", false},
		{"GET /issues/{id}/runs", false, false, a.runList, "Inspect newest runs first, including stalled and terminal history.", false},
		{"GET /runs/{id}", false, false, a.runGet, "Re-read your lease and state before resuming.", false},
		{"POST /runs/{id}/heartbeat", true, false, a.runHeartbeat, "Send {note?} well before the 10-minute lease expires, including while waiting.", false},
		{"POST /runs/{id}/finish", true, false, a.runFinish, "Send {outcome:'succeeded'|'failed',summary,links?}; links are HTTPS pr/commit/url entries.", false},
		{"POST /runs/{id}/cancel", true, false, a.runCancel, "Cancel your own run; any person may cancel it too. Open requests are withdrawn.", false},
		{"POST /issues/{id}/requests", true, false, a.requestCreate, "Raise {kind:'question'|'approval',title,body?,options?,to?,runId?}; omitted to defaults to delegator/owner, null means any person.", false},
		{"GET /requests", false, false, a.requestList, "Filter by state, to (subject, me, or none), and issue (ID or identifier).", false},
		{"GET /requests/{id}", false, false, a.requestGet, "Read a handoff and its answer.", false},
		{"POST /requests/{id}/answer", true, true, a.requestAnswer, "Answer a question addressed to you using {option?,body?}; choose one offered option if present.", false},
		{"POST /requests/{id}/withdraw", true, false, a.requestWithdraw, "Withdraw your open request when it is no longer needed.", false},
		{"GET /agent-guide", false, false, a.agentGuide, "Read this protocol.", true},
	}
}

type markdown string

func (a *API) agentGuide(_ *request) (any, int, error) {
	var out strings.Builder
	out.WriteString(`# Tracker agent protocol

## Identity

Ask an Admin to mint an external-subject Access Key for your immutable handle.
No Tracker-issued secret is involved. Exchange the key for a short-lived
assertion, never send the raw key here:

` + "```sh\napth access-keys create --project <project> --space tracker --external <handle> --scope tracker:read --scope tracker:write\nprintf %s \"$KEY\" | apth access-keys exchange --project <project>\n```\n" + `
Send Authorization: Bearer <assertion> and Content-Type: application/json.
GET needs tracker:read; other methods need tracker:write; neither implies the
other. Refresh assertions before expiry. Admin operations refuse every key.

Your first call is POST /agents/register with {name, description?, ownerSub}.
The handle comes from your assertion, not the body. The owner must be a person
who has written in this workspace while signed in; use that person's subject.
The owner is claimed, not consented: an Admin may correct it or disable you.
Registration returns 201 when new. It is safe to call on every start: an active
agent receives 200 with its existing record, without applying the body.
Disabled agents cannot register again. GET /agent-guide is available before
registration; all other authenticated routes require an active agent.

## Inbox and event loop

Initialize the event cursor first, then read the inbox. Poll the feed using its
next cursor (drain full pages before sleeping); persist the cursor only after
handling every item. Re-read relevant entities: events are notifications, not
commands. The inbox is the recovery authority if your local cursor is lost.
Handle requests first, then answers and mentions; acknowledge an answer by its
request ID and a mention by its comment ID. Assignments are actionable work,
including Backlog. If activeRun is live, resume it instead of starting another.
Do not start work blocked by unfinished dependencies or your open requests.

## Runs and handoffs

One non-terminal run may hold an issue. Keep heartbeating even while waiting.
A stalled run cannot be revived: stop the old execution and start a fresh run;
that start closes the expired lease as failed/lease_expired and withdraws its
requests. Reassignment or disabling cancels runs and withdraws open requests.
Only attach a request to your own live run on that same issue. It makes the run
waiting; the last answer or withdrawal returns it to running. Questions may
be addressed to agents. Approval and review are answered only by people.

Finishing succeeded is refused while an approval of the run is open: resolve
or withdraw it first. Under review, success opens a review to your delegator
(or owner) and withdraws open questions. Do not set a completed status yourself.
Only a person's approval completes the issue; rejection arrives as an answer.
Under direct you may set a completed status yourself; finishing a run alone
never changes issue status. Failed/canceled runs withdraw all open requests.

## Safe retries and conflicts

Use a fresh Idempotency-Key (1–128 characters) for every new POST operation;
retry an uncertain response with exactly the same path and body and same key.
The first response is replayed for 24 hours per actor, across all of its keys.
Use a new key for each heartbeat. Multipart attachment uploads are excluded.
POST /agents/register is intrinsically idempotent and ignores Idempotency-Key;
it always checks the current registration and disabled state.
For field edits, send expectedUpdatedAt from your latest issue read.

401: exchange again; raw_key_not_accepted means you sent a raw key.
403 insufficient_scope: ask for the missing scope. 403 key_subject: register an
unknown handle with POST /agents/register; ask an Admin about a disabled agent.
403 forbidden: do not retry as another actor; ask the delegator to perform the
prohibited action.
409 conflict: re-read the issue/run/request. Stop after lease expiry or
reassignment; do not overwrite an updated issue. Resolve open approvals before
success. Never reuse an idempotency key for a different operation.

## Routes

All routes below are relative to /api/tracker/v1. This inventory is generated
from the same table used to register the handlers.

| Method and route | Protocol |
| --- | --- |
`)
	for _, route := range a.routes() {
		if route.guide != "" {
			fmt.Fprintf(&out, "| `%s` | %s |\n", route.pattern, strings.ReplaceAll(route.guide, "|", "\\|"))
		}
	}
	return markdown(out.String()), 200, nil
}
