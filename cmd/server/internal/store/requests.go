package store

import (
	"encoding/json"
	"slices"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

const requestJSON = `jsonb_build_object('id',q.id,'issue',jsonb_build_object('id',i.id,'identifier',w.key||'-'||i.number,'title',i.title,'statusId',i.status_id),
 'kind',q.kind,'from',jsonb_build_object('sub',q.from_sub,'name',q.from_name),
 'to',CASE WHEN q.to_sub IS NULL THEN NULL ELSE jsonb_build_object('sub',q.to_sub,'name',q.to_name) END,
 'title',q.title,'body',q.body,'options',q.options,'runId',q.run_id,'state',q.state,'createdAt',q.created_at,
 'answer',CASE WHEN q.answered_at IS NULL THEN NULL ELSE jsonb_build_object('option',q.answer_option,'body',q.answer_body,'by',jsonb_build_object('sub',q.answered_by_sub,'name',q.answered_by_name),'at',q.answered_at) END)`
const requestFrom = ` FROM tracker_request q JOIN tracker_issue i ON i.id=q.issue_id JOIN tracker_workspace w ON w.id=i.workspace_id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL `

func scanRequest(row scanner) (domain.Request, error) {
	var data []byte
	var request domain.Request
	if err := row.Scan(&data); err != nil {
		return request, err
	}
	err := json.Unmarshal(data, &request)
	return request, err
}

func (t *Tx) Request(id string) (domain.Request, error) {
	return scanRequest(t.SQL.QueryRowContext(t.Context, `SELECT `+requestJSON+requestFrom+` AND q.id=$2`, t.WorkspaceID, id))
}

type RequestCreate struct {
	Kind    string   `json:"kind"`
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Options []string `json:"options"`
	To      *string  `json:"to"`
	RunID   *string  `json:"runId"`
}

func (t *Tx) insertRequest(issue domain.Issue, input RequestCreate, from domain.Person, to *domain.Person) (domain.Request, error) {
	id := ulid.Make().String()
	var sub, name any
	if to != nil {
		sub, name = to.Sub, to.Name
	}
	options, err := jsonValue(input.Options)
	if err != nil {
		return domain.Request{}, err
	}
	if err := t.Exec(`INSERT INTO tracker_request(id,issue_id,kind,from_sub,from_name,to_sub,to_name,title,body,options,run_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, issue.ID, input.Kind, from.Sub, from.Name, sub, name, input.Title, input.Body, options, input.RunID, t.now()); err != nil {
		return domain.Request{}, err
	}
	return t.Request(id)
}

func (t *Tx) CreateRequest(issueID string, input RequestCreate, actor domain.Actor, to *domain.Person) (domain.Request, error) {
	issue, err := t.Issue(issueID)
	if err != nil {
		return domain.Request{}, err
	}
	if !slices.Contains([]string{"question", "approval"}, input.Kind) || !domain.Text(input.Title, 1, 200) || len(input.Body) > 20<<10 || !domain.Text(input.Body, 0, 20<<10) || len(input.Options) > 6 {
		return domain.Request{}, invalid("Invalid request kind, title, body or options")
	}
	if input.Kind == "approval" {
		input.Options = []string{"approve", "reject"}
	}
	if input.Options == nil {
		input.Options = []string{}
	}
	for i, option := range input.Options {
		if !domain.Text(option, 1, 200) || slices.Contains(input.Options[:i], option) {
			return domain.Request{}, invalid("Options must be distinct nonempty strings of at most 200 characters")
		}
	}
	if input.To == nil && actor.Kind == "agent" {
		to = issue.Delegator
		if to == nil {
			to = &actor.Agent.Owner
		}
	}
	if input.RunID != nil {
		run, err := t.ownedRun(*input.RunID, actor, domain.HeartbeatRun)
		if err != nil {
			return domain.Request{}, err
		}
		if run.Issue.ID != issue.ID {
			return domain.Request{}, invalid("Run must belong to this issue")
		}
		if err := t.Exec(`UPDATE tracker_run SET state='waiting' WHERE id=$1`, run.ID); err != nil {
			return domain.Request{}, err
		}
	}
	return t.insertRequest(issue, input, actor.Person, to)
}

type RequestAnswer struct {
	Option *string `json:"option"`
	Body   string  `json:"body"`
}

func (t *Tx) AnswerRequest(id string, input RequestAnswer, actor domain.Actor) (domain.Request, error) {
	request, err := t.Request(id)
	if err != nil {
		return request, err
	}
	to := ""
	if request.To != nil {
		to = request.To.Sub
	}
	if !domain.Can(actor, domain.AnswerRequest, domain.Target{OwnerSub: to, RequestKind: request.Kind}) {
		return request, httpx.Forbidden()
	}
	if request.State != "open" {
		return request, httpx.Conflict("The request is not open")
	}
	if len(input.Body) > 20<<10 || !domain.Text(input.Body, 0, 20<<10) {
		return request, invalid("Answer body must be at most 20 KiB")
	}
	if len(request.Options) > 0 && (input.Option == nil || !slices.Contains(request.Options, *input.Option)) {
		return request, invalid("Answer option must be one of the request options")
	}
	if len(request.Options) == 0 && input.Option != nil {
		return request, invalid("This request has no answer options")
	}
	if request.Kind == "review" && input.Option != nil && *input.Option == "approve" {
		statuses, err := t.Statuses()
		if err != nil {
			return request, err
		}
		completed := ""
		for _, status := range statuses {
			if status.Category == "completed" {
				completed = status.ID
				break
			}
		}
		if completed == "" {
			return request, httpx.Conflict("The workspace has no completed status")
		}
		if _, err := t.PatchIssue(request.Issue.ID, IssuePatch{StatusID: Field[string]{Present: true, Value: &completed}}, actor.Person, nil); err != nil {
			return request, err
		}
	}
	if err := t.Exec(`UPDATE tracker_request SET state='answered',answer_option=$2,answer_body=$3,answered_by_sub=$4,answered_by_name=$5,answered_at=$6 WHERE id=$1`, id, input.Option, input.Body, actor.Sub, actor.Name, t.now()); err != nil {
		return request, err
	}
	if request.RunID != nil {
		if err := t.Exec(`UPDATE tracker_run SET state='running' WHERE id=$1 AND state='waiting' AND NOT EXISTS(SELECT 1 FROM tracker_request WHERE run_id=$1 AND state='open')`, *request.RunID); err != nil {
			return request, err
		}
	}
	return t.Request(id)
}

func (t *Tx) Inbox(actor domain.Actor) ([]domain.InboxItem, error) {
	list := []domain.InboxItem{}
	predicate := ` AND q.state='open' AND (q.to_sub=$2 OR q.to_sub IS NULL)`
	if actor.Kind == "agent" {
		predicate = ` AND ((q.state='open' AND q.to_sub=$2) OR (q.state='answered' AND q.from_sub=$2))`
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+requestJSON+requestFrom+predicate+` ORDER BY q.created_at,q.id`, t.WorkspaceID, actor.Sub)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		request, err := scanRequest(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		kind := "request"
		if request.State == "answered" {
			kind = "answer"
		}
		list = append(list, domain.InboxItem{Kind: kind, Request: &request})
	}
	err = rows.Err()
	rows.Close()
	if err != nil || actor.Kind != "agent" {
		return list, err
	}
	rows, err = t.SQL.QueryContext(t.Context, `SELECT i.id,s.category,
 EXISTS(SELECT 1 FROM tracker_run r WHERE r.issue_id=i.id AND r.state IN ('running','waiting') AND r.lease_expires_at >= $4 AND r.agent_id<>$3),
 EXISTS(SELECT 1 FROM tracker_request q WHERE q.issue_id=i.id AND q.state='open' AND q.from_sub=$2
   AND NOT EXISTS(SELECT 1 FROM tracker_run expired WHERE expired.id=q.run_id AND expired.state IN ('running','waiting') AND expired.lease_expires_at < $4)),
 EXISTS(SELECT 1 FROM tracker_issue_block b JOIN tracker_issue blocker ON blocker.id=b.blocker_id JOIN tracker_status bs ON bs.id=blocker.status_id WHERE b.blocked_id=i.id AND blocker.deleted_at IS NULL AND bs.category NOT IN ('completed','canceled'))
 FROM tracker_issue i JOIN tracker_status s ON s.id=i.status_id LEFT JOIN tracker_sprint sp ON sp.id=i.sprint_id
 WHERE i.workspace_id=$1 AND i.assignee_sub=$2 AND i.deleted_at IS NULL
 ORDER BY `+prioritySQL+`,CASE WHEN sp.started_at IS NOT NULL AND sp.closed_at IS NULL THEN 0 ELSE 1 END,i.number`, t.WorkspaceID, actor.Sub, actor.AgentID, t.now())
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		var facts domain.ActionableInput
		if err := rows.Scan(&id, &facts.Category, &facts.OtherActiveRun, &facts.OwnOpenRequest, &facts.UnfinishedBlock); err != nil {
			rows.Close()
			return nil, err
		}
		if domain.Actionable(facts) {
			ids = append(ids, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		issue, err := t.Issue(id)
		if err != nil {
			return nil, err
		}
		list = append(list, domain.InboxItem{Kind: "assignment", Issue: &issue.IssueSummary})
	}
	return list, nil
}
