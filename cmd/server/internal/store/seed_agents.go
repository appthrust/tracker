package store

import (
	"fmt"
	"time"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

// seedAgents mirrors the Agents fixture shared with the SPA mock. Existing
// issue numbers are never moved; the two agent reports are appended as 41/42.
func (t *Tx) seedAgents(people []domain.Person, statuses []domain.Status, projectID string) error {
	now, previousClock := t.now(), t.clock
	defer func() { t.clock = previousClock }()
	at := func(delta time.Duration) time.Time { return now.Add(delta) }
	setClock := func(instant time.Time) { t.clock = func() time.Time { return instant } }
	admin := domain.Actor{Person: people[0], Role: "Admin", Kind: "person"}
	agents := map[string]domain.Agent{}
	for _, f := range []struct {
		handle, name, description string
		owner                     int
		disabled                  bool
		created, updated, seen    time.Duration
	}{
		{"astra", "Astra", "Backend implementer. Go handlers, store queries, migrations and their tests. Delegate issues with a clear acceptance check.", 1, false, -14 * 24 * time.Hour, -14 * 24 * time.Hour, -2 * time.Minute},
		{"opus-ui", "Opus UI", "UI implementer. React screens, copy and accessibility in the SPA. Delegate issues that include the expected screen or a screenshot.", 0, false, -7 * 24 * time.Hour, -7 * 24 * time.Hour, -time.Minute},
		{"claude", "Claude", "Planner and triage. Reads new reports, finds duplicates, proposes priority and sprint. Does not change code.", 2, false, -14 * 24 * time.Hour, -14 * 24 * time.Hour, -2 * time.Hour},
		{"legacy-bot", "Legacy bot", "Old nightly triage script. Replaced by claude.", 0, true, -60 * 24 * time.Hour, -30 * 24 * time.Hour, -32 * 24 * time.Hour},
	} {
		a, err := t.CreateAgent(AgentCreate{Handle: f.handle, Name: f.name, Description: f.description, OwnerSub: people[f.owner].Sub}, people[f.owner], admin)
		if err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_agent SET disabled=$2,created_at=$3,updated_at=$4,last_seen_at=$5 WHERE id=$1`, a.ID, f.disabled, at(f.created), at(f.updated), at(f.seen)); err != nil {
			return err
		}
		agents[f.handle] = a
	}
	for _, f := range []struct {
		number    int
		handle    string
		delegator int
		offset    time.Duration
	}{
		{15, "astra", 0, -40 * time.Minute}, {27, "opus-ui", 0, -45 * time.Minute}, {9, "astra", 1, -4 * time.Hour},
		{16, "astra", 0, -3 * time.Hour}, {4, "astra", 1, -27 * time.Hour}, {21, "claude", 0, -4 * time.Hour},
		{13, "opus-ui", 0, -24 * time.Hour}, {26, "opus-ui", 2, -24 * time.Hour}, {19, "astra", 1, -48 * time.Hour},
	} {
		setClock(at(f.offset))
		person := agents[f.handle].Person()
		issue, err := t.PatchIssue(fmt.Sprintf("APT-%d", f.number), IssuePatch{AssigneeSub: Field[string]{Present: true, Value: &person.Sub}}, people[f.delegator], &person)
		if err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_issue SET updated_at=$2 WHERE id=$1`, issue.ID, at(f.offset)); err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_activity SET created_at=$2 WHERE issue_id=$1 AND field IN ('assignee','delegator')`, issue.ID, at(f.offset)); err != nil {
			return err
		}
	}
	for _, f := range []struct {
		handle string
		offset time.Duration
		input  IssueCreate
		self   bool
	}{
		{"claude", -5 * time.Hour, IssueCreate{Title: "Three reports describe the same stale status", Type: "task", Priority: "high", StatusID: statuses[0].ID, ProjectID: &projectID, Description: "APT-4, APT-22 and APT-28 all show a status that lags behind the real one by one refresh. Proposal: keep APT-4 and close the other two as duplicates."}, false},
		{"astra", -3 * time.Hour, IssueCreate{Title: "Flaky test: lease renewal in store/runs_test", Type: "bug", Priority: "medium", StatusID: statuses[1].ID, ProjectID: &projectID, Description: "TestHeartbeatRenewsLease fails about 1 in 30 runs on CI.", Report: &domain.Report{Environment: "local", Surface: "platform-api", Version: "0.1.13", Steps: "go test -count=30 ./cmd/server/internal/store -run TestHeartbeatRenewsLease", Expected: "All runs pass.", Actual: "One run fails with lease_expired."}}, true},
	} {
		setClock(at(f.offset))
		person := agents[f.handle].Person()
		var assignee *domain.Person
		if f.self {
			assignee = &person
		}
		issue, err := t.CreateIssue(f.input, person, assignee)
		if err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_issue SET created_at=$2,updated_at=$2 WHERE id=$1`, issue.ID, at(f.offset)); err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_activity SET created_at=$2 WHERE issue_id=$1`, issue.ID, at(f.offset)); err != nil {
			return err
		}
	}
	issues := map[int]domain.Issue{}
	for _, n := range []int{1, 4, 9, 15, 16, 21, 22, 27, 41} {
		i, err := t.Issue(fmt.Sprintf("APT-%d", n))
		if err != nil {
			return err
		}
		issues[n] = i
	}
	summary16 := "The CLI refreshed its login only after a request failed with 401, so the first command after one hour always failed.\n\n- Refresh the token when less than 5 minutes of its lifetime remain.\n- Retry once on 401 after a refresh.\n- Added `TestLoginRefreshBeforeExpiry`."
	summary4 := "Status reads now bypass the list cache after a status change. Added a regression test for the list endpoint."
	runs := map[int]string{}
	for _, f := range []struct {
		number                                int
		handle, state, session, note, summary string
		start, heartbeat                      time.Duration
		links                                 []domain.RunLink
	}{
		{15, "astra", "running", "astra · lane-2", "running go test ./cmd/server/... after removing 14 unused fixtures", "", -35 * time.Minute, -2 * time.Minute, nil},
		{27, "opus-ui", "waiting", "opus-ui · a11y pass", "waiting for a decision on the close-button label", "", -40 * time.Minute, -time.Minute, nil},
		{9, "astra", "running", "astra · lane-1", "comparing the Gateway page with the current kubeconfig flow", "", -3 * time.Hour, -52 * time.Minute, nil},
		{16, "astra", "succeeded", "astra · lane-2", "opening the pull request", summary16, -2 * time.Hour, -25 * time.Minute, []domain.RunLink{{Kind: "pr", URL: "https://github.com/appthrust/tracker/pull/142", Title: "Refresh the CLI login before the token expires"}}},
		{4, "astra", "succeeded", "astra · lane-1", "opening the pull request", summary4, -26 * time.Hour, -24 * time.Hour, []domain.RunLink{{Kind: "pr", URL: "https://github.com/appthrust/tracker/pull/138", Title: "Invalidate the status cache on change"}}},
	} {
		id := ulid.Make().String()
		runs[f.number] = id
		var finished any
		if f.state == "succeeded" {
			finished = at(f.heartbeat)
		}
		if f.links == nil {
			f.links = []domain.RunLink{}
		}
		links, err := jsonValue(f.links)
		if err != nil {
			return err
		}
		if err := t.Exec(`INSERT INTO tracker_run(id,issue_id,agent_id,state,session,note,summary,links,started_at,heartbeat_at,lease_expires_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, issues[f.number].ID, agents[f.handle].ID, f.state, f.session, f.note, f.summary, links, at(f.start), at(f.heartbeat), at(f.heartbeat+10*time.Minute), finished); err != nil {
			return err
		}
		setClock(at(f.start))
		if err := t.event(issues[f.number].ID, agents[f.handle].Person(), "run.started", id); err != nil {
			return err
		}
		if finished != nil {
			setClock(at(f.heartbeat))
			if err := t.event(issues[f.number].ID, agents[f.handle].Person(), "run.finished", id); err != nil {
				return err
			}
		}
	}
	astra, opus, claude := agents["astra"].Person(), agents["opus-ui"].Person(), agents["claude"].Person()
	approve := []string{"approve", "reject"}
	for _, f := range []struct {
		number            int
		kind, title, body string
		from              domain.Person
		to                *domain.Person
		run               bool
		options           []string
		created           time.Duration
		answer            *domain.RequestAnswer
		ack               bool
	}{
		{27, "question", "Which label should the panel's close button use?", `The panel's close button has no visible text. "Close" matches the rest of the app; "Dismiss" is what the screen reader announces today.`, opus, &people[0], true, []string{"Close", "Dismiss", `Keep both: visible "Close", spoken "Dismiss"`}, -8 * time.Minute, nil, false},
		{15, "question", "Delete the fixtures under testdata/legacy too?", "", astra, &people[0], true, []string{"Yes, delete them", "No, keep them"}, -28 * time.Minute, &domain.RequestAnswer{Option: new("Yes, delete them"), Body: "They are unused since 0.1.7.", By: people[0], At: at(-20 * time.Minute)}, true},
		{16, "review", "Review: CLI login expires too early", summary16, astra, &people[0], true, approve, -25 * time.Minute, nil, false},
		{4, "review", "Review: Platform API returns stale status", summary4, astra, &people[1], true, approve, -24 * time.Hour, &domain.RequestAnswer{Option: new("reject"), Body: "Still stale right after a status change: the 304 path keeps the old ETag. Please add a test for it.", By: people[1], At: at(-20 * time.Hour)}, false},
		{1, "approval", "Add APT-1 to the current sprint?", "Two people lost their filters on appthrust.dev this week. It is urgent but sits in the backlog without a sprint.", claude, nil, false, approve, -90 * time.Minute, nil, false},
		{21, "question", "Which open bugs look like duplicates of APT-22?", "", people[0], &claude, false, []string{}, -3 * time.Hour, &domain.RequestAnswer{Body: "APT-4 and APT-28 describe the same stale-cache symptom; I filed APT-41 to merge them.", By: claude, At: at(-2 * time.Hour)}, false},
	} {
		setClock(at(f.created))
		input := RequestCreate{Kind: f.kind, Title: f.title, Body: f.body, Options: f.options}
		if f.run {
			input.RunID = new(runs[f.number])
		}
		request, err := t.insertRequest(issues[f.number], input, f.from, f.to)
		if err != nil {
			return err
		}
		if f.answer != nil {
			answer := f.answer
			var ack any
			if f.ack {
				ack = answer.At
			}
			if err := t.Exec(`UPDATE tracker_request SET state='answered',answer_option=$2,answer_body=$3,answered_by_sub=$4,answered_by_name=$5,answered_at=$6,answer_acknowledged_at=$7 WHERE id=$1`, request.ID, answer.Option, answer.Body, answer.By.Sub, answer.By.Name, answer.At, ack); err != nil {
				return err
			}
			setClock(answer.At)
			if err := t.event(request.Issue.ID, answer.By, "request.answered", request.ID); err != nil {
				return err
			}
		}
	}
	for _, f := range []struct {
		number int
		author domain.Person
		offset time.Duration
		body   string
	}{
		{22, people[1], -time.Hour, "@astra could you check whether the cursor encoding changed with APT-15? The skipped rows start after page 2."},
		{41, claude, -5 * time.Hour, "Filed from triage. Evidence: the three reports name the same endpoint and the same one-refresh lag."},
	} {
		setClock(at(f.offset))
		c, err := t.CreateComment(issues[f.number].ID, f.body, f.author)
		if err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_comment SET created_at=$2 WHERE id=$1`, c.ID, at(f.offset)); err != nil {
			return err
		}
		if err := t.Exec(`UPDATE tracker_issue SET updated_at=$2 WHERE id=$1`, c.IssueID, at(f.offset)); err != nil {
			return err
		}
	}
	return nil
}
