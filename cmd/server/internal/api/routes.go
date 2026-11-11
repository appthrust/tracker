package api

import (
	"fmt"
	"strings"
)

type routeDefinition struct {
	pattern  string
	mutation bool
	roles    bool
	handler  endpoint
	guide    string
}

// This is the registration and agent-guide authority. Special binary/public
// handlers (Directory avatar and OpenAPI) are mounted separately.
func (a *API) routes() []routeDefinition {
	return []routeDefinition{
		{"GET /me", false, true, a.me, "Confirm your kind, agent handle, owner and scopes."},
		{"GET /workspace", false, false, a.workspaceGet, "Read the agentCompletion policy."},
		{"PATCH /workspace", true, true, a.workspacePatch, ""},
		{"GET /statuses", false, false, a.statusList, "Read workflow status IDs and categories."},
		{"POST /statuses", true, true, a.statusCreate, ""},
		{"PATCH /statuses/{id}", true, true, a.statusPatch, ""},
		{"DELETE /statuses/{id}", true, true, a.statusDelete, ""},
		{"PUT /statuses/order", true, true, a.statusOrder, ""},
		{"GET /labels", false, false, a.labelList, ""},
		{"POST /labels", true, true, a.labelCreate, ""},
		{"PATCH /labels/{id}", true, true, a.labelPatch, ""},
		{"DELETE /labels/{id}", true, true, a.labelDelete, ""},
		{"GET /projects", false, false, a.projectList, ""},
		{"POST /projects", true, false, a.projectCreate, ""},
		{"GET /projects/{id}", false, false, a.projectGet, ""},
		{"PATCH /projects/{id}", true, true, a.projectPatch, ""},
		{"DELETE /projects/{id}", true, true, a.projectDelete, ""},
		{"GET /sprints", false, false, a.sprintList, ""},
		{"POST /sprints", true, false, a.sprintCreate, ""},
		{"GET /sprints/{id}", false, false, a.sprintGet, ""},
		{"PATCH /sprints/{id}", true, false, a.sprintPatch, ""},
		{"POST /sprints/{id}/start", true, false, a.sprintStart, ""},
		{"POST /sprints/{id}/close", true, false, a.sprintClose, ""},
		{"DELETE /sprints/{id}", true, true, a.sprintDelete, ""},
		{"GET /sprints/{id}/burndown", false, false, a.sprintBurndown, ""},
		{"GET /velocity", false, false, a.velocity, ""},
		{"GET /issues", false, false, a.issueList, "Filter issues; list rows include delegator, activeRun and openRequestCount."},
		{"POST /issues", true, false, a.issueCreate, "Create an issue; you are its reporter. You may assign it to yourself."},
		{"GET /issues/{id}", false, false, a.issueGet, "Read current fields, updatedAt and blocking issues before editing."},
		{"PATCH /issues/{id}", true, false, a.issuePatch, "Edit only if assignee or reporter; send expectedUpdatedAt to avoid overwriting changes."},
		{"DELETE /issues/{id}", true, true, a.issueDelete, ""},
		{"GET /issues/{id}/timeline", false, false, a.timeline, "Read comments, activities, runs and requests."},
		{"POST /issues/{id}/comments", true, false, a.commentCreate, "Discuss any issue; @handle mentions a registered agent."},
		{"PATCH /comments/{id}", true, false, a.commentPatch, "Edit your own comment; mentions are reparsed."},
		{"DELETE /comments/{id}", true, true, a.commentDelete, ""},
		{"POST /issues/{id}/attachments", true, false, a.attachmentCreate, "Attach evidence (multipart; excluded from idempotent replay)."},
		{"GET /attachments/{id}", false, false, a.attachmentGet, ""},
		{"DELETE /attachments/{id}", true, true, a.attachmentDelete, ""},
		{"GET /views", false, false, a.viewList, ""},
		{"POST /views", true, true, a.viewCreate, ""},
		{"PATCH /views/{id}", true, true, a.viewPatch, ""},
		{"DELETE /views/{id}", true, true, a.viewDelete, ""},
		{"GET /people", false, false, a.people, "Keys cannot access Directory; returns an empty unavailable result."},
		{"GET /agents", false, false, a.agentList, "Discover agents; includeDisabled=true also returns retired identities."},
		{"POST /agents", true, true, a.agentCreate, ""},
		{"PATCH /agents/{id}", true, true, a.agentPatch, ""},
		{"GET /inbox", false, false, a.inbox, "Requests first, then answers, mentions and actionable assignments."},
		{"POST /inbox/ack", true, false, a.inboxAck, "Acknowledge {answers:[requestId], mentions:[commentId]} after handling them."},
		{"GET /events", false, false, a.events, "Initialize without after (empty items and current next); poll with after=next and limit 1–500."},
		{"POST /issues/{id}/runs", true, false, a.runStart, "Start only on your assigned issue with {session?,note?}; retain the returned run ID."},
		{"GET /issues/{id}/runs", false, false, a.runList, "Inspect newest runs first, including stalled and terminal history."},
		{"GET /runs/{id}", false, false, a.runGet, "Re-read your lease and state before resuming."},
		{"POST /runs/{id}/heartbeat", true, false, a.runHeartbeat, "Send {note?} well before the 10-minute lease expires, including while waiting."},
		{"POST /runs/{id}/finish", true, false, a.runFinish, "Send {outcome:'succeeded'|'failed',summary,links?}; links are HTTPS pr/commit/url entries."},
		{"POST /runs/{id}/cancel", true, false, a.runCancel, "Cancel your own run; any person may cancel it too. Open requests are withdrawn."},
		{"POST /issues/{id}/requests", true, false, a.requestCreate, "Raise {kind:'question'|'approval',title,body?,options?,to?,runId?}; omitted to defaults to delegator/owner, null means any person."},
		{"GET /requests", false, false, a.requestList, "Filter by state, to (subject, me, or none), and issue (ID or identifier)."},
		{"GET /requests/{id}", false, false, a.requestGet, "Read a handoff and its answer."},
		{"POST /requests/{id}/answer", true, true, a.requestAnswer, "Answer a question addressed to you using {option?,body?}; choose one offered option if present."},
		{"POST /requests/{id}/withdraw", true, false, a.requestWithdraw, "Withdraw your open request when it is no longer needed."},
		{"GET /agent-guide", false, false, a.agentGuide, "Read this protocol."},
	}
}

type markdown string

func (a *API) agentGuide(_ *request) (any, int, error) {
	var out strings.Builder
	out.WriteString(`# Tracker agent protocol

## Identity

Ask an Admin to register your immutable handle and mint an external-subject
Access Key with that same handle. No Tracker-issued secret is involved.
Exchange the key for a short-lived assertion, never send the raw key here:

` + "```sh\napth access-keys create --project <project> --space tracker --external <handle> --scope tracker:read --scope tracker:write\nprintf %s \"$KEY\" | apth access-keys exchange --project <project>\n```\n" + `
Send Authorization: Bearer <assertion> and Content-Type: application/json.
GET needs tracker:read; other methods need tracker:write; neither implies the
other. Refresh assertions before expiry. Admin operations refuse every key.

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
For field edits, send expectedUpdatedAt from your latest issue read.

401: exchange again; raw_key_not_accepted means you sent a raw key.
403 insufficient_scope: ask for the missing scope. 403 key_subject: ask the
Admin whether your handle is registered and active. 403 forbidden: do not
retry as another actor; ask the delegator to perform the prohibited action.
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
