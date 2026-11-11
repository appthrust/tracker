package store

import (
	"encoding/json"
	"net/url"
	"slices"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

const runJSON = `jsonb_build_object('id',r.id,'issue',jsonb_build_object('id',i.id,'identifier',w.key||'-'||i.number,'title',i.title,'statusId',i.status_id),
 'agent',jsonb_build_object('sub','agent:'||a.id,'name',a.name,'agent',jsonb_build_object('id',a.id,'handle',a.handle,'owner',jsonb_build_object('sub',a.owner_sub,'name',a.owner_name),'disabled',a.disabled)),
 'state',r.state,'reason',r.reason,'session',r.session,'note',r.note,'summary',r.summary,'links',r.links,
 'startedAt',r.started_at,'heartbeatAt',r.heartbeat_at,'leaseExpiresAt',r.lease_expires_at,'finishedAt',r.finished_at)`
const runFrom = ` FROM tracker_run r JOIN tracker_issue i ON i.id=r.issue_id JOIN tracker_workspace w ON w.id=i.workspace_id JOIN tracker_agent a ON a.id=r.agent_id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL `

func scanRun(row scanner, now time.Time) (domain.Run, error) {
	var data []byte
	var run domain.Run
	if err := row.Scan(&data); err != nil {
		return run, err
	}
	if err := json.Unmarshal(data, &run); err != nil {
		return run, err
	}
	run.State = domain.RunState(run.State, run.LeaseExpiresAt, now)
	return run, nil
}

func (t *Tx) Run(id string) (domain.Run, error) {
	return scanRun(t.SQL.QueryRowContext(t.Context, `SELECT `+runJSON+runFrom+` AND r.id=$2`, t.WorkspaceID, id), t.now())
}

func (t *Tx) Runs(issueID string) ([]domain.Run, error) {
	issue, err := t.Issue(issueID)
	if err != nil {
		return nil, err
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+runJSON+runFrom+` AND i.id=$2 ORDER BY r.started_at DESC,r.id DESC`, t.WorkspaceID, issue.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []domain.Run{}
	now := t.now()
	for rows.Next() {
		run, err := scanRun(rows, now)
		if err != nil {
			return nil, err
		}
		list = append(list, run)
	}
	return list, rows.Err()
}

func (t *Tx) leaseDuration() time.Duration {
	if t.runLease > 0 {
		return t.runLease
	}
	return 10 * time.Minute
}

type RunStart struct {
	Session string `json:"session"`
	Note    string `json:"note"`
}

func (t *Tx) StartRun(issueID string, input RunStart, actor domain.Actor) (domain.Run, error) {
	issue, err := t.Issue(issueID)
	if err != nil {
		return domain.Run{}, err
	}
	owner := ""
	if issue.Assignee != nil {
		owner = issue.Assignee.Sub
	}
	if !domain.Can(actor, domain.StartRun, domain.Target{OwnerSub: owner}) {
		return domain.Run{}, httpx.Forbidden()
	}
	if !domain.Text(input.Session, 0, 200) || !domain.Text(input.Note, 0, 200) {
		return domain.Run{}, invalid("Session and note must be at most 200 characters")
	}
	if issue.ActiveRun != nil {
		if issue.ActiveRun.State != "stalled" {
			return domain.Run{}, httpx.Conflict("An active run already holds this issue")
		}
		if err := t.closeRun(issue.ActiveRun.ID, "failed", "lease_expired"); err != nil {
			return domain.Run{}, err
		}
	}
	id, now := ulid.Make().String(), t.now()
	if err := t.Exec(`INSERT INTO tracker_run(id,issue_id,agent_id,state,session,note,started_at,heartbeat_at,lease_expires_at) VALUES($1,$2,$3,'running',$4,$5,$6,$6,$7)`, id, issue.ID, actor.AgentID, input.Session, input.Note, now, now.Add(t.leaseDuration())); err != nil {
		return domain.Run{}, err
	}
	return t.Run(id)
}

func (t *Tx) ownedRun(id string, actor domain.Actor, action domain.Action) (domain.Run, error) {
	run, err := t.Run(id)
	if err != nil {
		return run, err
	}
	if !domain.Can(actor, action, domain.Target{OwnerSub: run.Agent.Sub}) {
		return run, httpx.Forbidden()
	}
	if !domain.LiveRun(run.State) {
		return run, httpx.Conflict("The run is terminal or its lease has expired")
	}
	return run, nil
}

func (t *Tx) HeartbeatRun(id string, note *string, actor domain.Actor) (domain.Run, error) {
	run, err := t.ownedRun(id, actor, domain.HeartbeatRun)
	if err != nil {
		return run, err
	}
	if note != nil {
		if !domain.Text(*note, 0, 200) {
			return run, invalid("Note must be at most 200 characters")
		}
		run.Note = *note
	}
	now := t.now()
	if err := t.Exec(`UPDATE tracker_run SET note=$2,heartbeat_at=$3,lease_expires_at=$4 WHERE id=$1`, id, run.Note, now, now.Add(t.leaseDuration())); err != nil {
		return run, err
	}
	return t.Run(id)
}

type RunFinish struct {
	Outcome string           `json:"outcome"`
	Summary string           `json:"summary"`
	Links   []domain.RunLink `json:"links"`
}

func (t *Tx) FinishRun(id string, input RunFinish, actor domain.Actor) (domain.Run, error) {
	run, err := t.ownedRun(id, actor, domain.FinishRun)
	if err != nil {
		return run, err
	}
	if !slices.Contains([]string{"succeeded", "failed"}, input.Outcome) || len(input.Summary) > 20<<10 || !domain.Text(input.Summary, 0, 20<<10) || len(input.Links) > 10 {
		return run, invalid("Invalid outcome, summary or links")
	}
	for _, link := range input.Links {
		u, err := url.Parse(link.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || !slices.Contains([]string{"pr", "commit", "url"}, link.Kind) || !domain.Text(link.Title, 0, 200) {
			return run, invalid("Links require an HTTPS URL, kind and a title of at most 200 characters")
		}
	}
	if input.Links == nil {
		input.Links = []domain.RunLink{}
	}
	links, err := jsonValue(input.Links)
	if err != nil {
		return run, err
	}
	if err := t.Exec(`UPDATE tracker_run SET state=$2,summary=$3,links=$4,finished_at=$5 WHERE id=$1`, id, input.Outcome, input.Summary, links, t.now()); err != nil {
		return run, err
	}
	if err := t.Exec(`UPDATE tracker_request SET state='withdrawn' WHERE run_id=$1 AND state='open' AND kind='question'`, id); err != nil {
		return run, err
	}
	var policy string
	if err := t.SQL.QueryRowContext(t.Context, `SELECT agent_completion FROM tracker_workspace WHERE id=$1`, t.WorkspaceID).Scan(&policy); err != nil {
		return run, err
	}
	if input.Outcome == "succeeded" && policy == "review" {
		issue, err := t.Issue(run.Issue.ID)
		if err != nil {
			return run, err
		}
		to := issue.Delegator
		if to == nil {
			to = &run.Agent.Agent.Owner
		}
		if _, err := t.insertRequest(issue, RequestCreate{Kind: "review", Title: "Review: " + truncateTitle(issue.Title, 192), Body: input.Summary, Options: []string{"approve", "reject"}, RunID: &id}, actor.Person, to); err != nil {
			return run, err
		}
	}
	return t.Run(id)
}

func truncateTitle(title string, limit int) string {
	count := 0
	for at := range title {
		if count == limit {
			return title[:at]
		}
		count++
	}
	return title
}

func (t *Tx) withdrawRunRequests(id string) error {
	return t.Exec(`UPDATE tracker_request SET state='withdrawn' WHERE run_id=$1 AND state='open'`, id)
}

func (t *Tx) closeRun(id, state, reason string) error {
	if err := t.Exec(`UPDATE tracker_run SET state=$2,reason=$3,finished_at=$4 WHERE id=$1`, id, state, reason, t.now()); err != nil {
		return err
	}
	return t.withdrawRunRequests(id)
}

func (t *Tx) CancelRun(id string, actor domain.Actor) (domain.Run, error) {
	run, err := t.Run(id)
	if err != nil {
		return run, err
	}
	if !domain.Can(actor, domain.CancelRun, domain.Target{OwnerSub: run.Agent.Sub}) {
		return run, httpx.Forbidden()
	}
	if !domain.LiveRun(run.State) && run.State != "stalled" {
		return run, httpx.Conflict("The run is terminal")
	}
	if err := t.closeRun(id, "canceled", "canceled_by:"+actor.Sub); err != nil {
		return run, err
	}
	return t.Run(id)
}
