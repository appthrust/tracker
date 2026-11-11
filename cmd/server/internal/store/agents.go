package store

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

const agentColumns = `a.id,a.handle,a.name,a.description,a.key_subject,a.owner_sub,a.owner_name,a.disabled,a.created_at,a.updated_at,
 (SELECT count(*) FROM tracker_run r WHERE r.agent_id=a.id AND r.state IN ('running','waiting') AND r.lease_expires_at >= $2),
 (SELECT count(*) FROM tracker_request q JOIN tracker_issue i ON i.id=q.issue_id WHERE i.workspace_id=a.workspace_id AND i.deleted_at IS NULL AND q.from_sub='agent:'||a.id AND q.state='open'),
 (SELECT max(r.heartbeat_at) FROM tracker_run r WHERE r.agent_id=a.id)`

func scanAgent(row scanner) (domain.Agent, error) {
	var a domain.Agent
	err := row.Scan(&a.ID, &a.Handle, &a.Name, &a.Description, &a.KeySubject, &a.Owner.Sub, &a.Owner.Name, &a.Disabled, &a.CreatedAt, &a.UpdatedAt, &a.ActiveRuns, &a.OpenRequests, &a.LastSeenAt)
	return a, err
}

func (t *Tx) Agent(id string) (domain.Agent, error) {
	return scanAgent(t.SQL.QueryRowContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND a.id=$3`, t.WorkspaceID, t.now(), id))
}

func (t *Tx) AgentBySubject(subject string) (domain.Actor, error) {
	a, err := scanAgent(t.SQL.QueryRowContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND a.key_subject=$3 AND NOT a.disabled`, t.WorkspaceID, t.now(), subject))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Actor{}, httpx.Fail(403, "key_subject", "The access key subject is not an active registered agent")
	}
	if err != nil {
		return domain.Actor{}, err
	}
	return domain.Actor{Person: a.Person(), Kind: "agent", AgentID: a.ID, Role: "Viewer", Key: true}, nil
}

func (t *Tx) Agents() ([]domain.Agent, error) {
	list := []domain.Agent{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND NOT a.disabled ORDER BY a.handle`, t.WorkspaceID, t.now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}

type AgentCreate struct {
	Handle      string `json:"handle"`
	Name        string `json:"name"`
	Description string `json:"description"`
	KeySubject  string `json:"keySubject"`
	OwnerSub    string `json:"ownerSub"`
}

var agentHandle = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)

func (t *Tx) CreateAgent(input AgentCreate, owner domain.Person, actor domain.Actor) (domain.Agent, error) {
	if !domain.Can(actor, domain.ManageWorkspace, domain.Target{}) {
		return domain.Agent{}, httpx.Forbidden()
	}
	if !agentHandle.MatchString(input.Handle) || !domain.Text(input.Name, 1, 200) || len(input.Description) > 4096 {
		return domain.Agent{}, invalid("Invalid agent handle, name or description")
	}
	if _, err := accesskey.ParseSubject("external:" + input.KeySubject); err != nil || strings.HasPrefix(input.KeySubject, "external:") {
		return domain.Agent{}, &domain.FieldError{Path: "keySubject", Message: "Use the external subject id without its prefix"}
	}
	if !domain.Text(owner.Sub, 1, 4096) || domain.ActorKind(owner.Sub) != "person" {
		return domain.Agent{}, invalid("An agent owner must be a person")
	}
	id := ulid.Make().String()
	if err := t.Exec(`INSERT INTO tracker_agent(id,workspace_id,handle,name,description,key_subject,owner_sub,owner_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, t.WorkspaceID, input.Handle, strings.TrimSpace(input.Name), input.Description, input.KeySubject, owner.Sub, owner.Name); err != nil {
		return domain.Agent{}, err
	}
	return t.Agent(id)
}

func (t *Tx) AgentAssignee(sub string) (*domain.Person, error) {
	a, err := t.Agent(strings.TrimPrefix(sub, "agent:"))
	if errors.Is(err, sql.ErrNoRows) || (err == nil && a.Disabled) {
		return nil, &domain.FieldError{Path: "assigneeSub", Message: "Agent must be active and belong to this workspace"}
	}
	if err != nil {
		return nil, err
	}
	p := a.Person()
	return &p, nil
}

func (t *Tx) issueActor(person domain.Person) (domain.Actor, error) {
	actor := domain.Actor{Person: person, Kind: domain.ActorKind(person.Sub)}
	if actor.Kind == "agent" {
		a, err := t.Agent(strings.TrimPrefix(person.Sub, "agent:"))
		if err != nil {
			return actor, err
		}
		if a.Disabled {
			return actor, httpx.Forbidden()
		}
		actor.Person, actor.AgentID = a.Person(), a.ID
	}
	return actor, nil
}

func (t *Tx) completionAllowed(person domain.Person, category string) error {
	if domain.ActorKind(person.Sub) == "person" {
		return nil
	}
	var policy string
	if err := t.SQL.QueryRowContext(t.Context, `SELECT agent_completion FROM tracker_workspace WHERE id=$1`, t.WorkspaceID).Scan(&policy); err != nil {
		return err
	}
	actor := domain.Actor{Person: person, Kind: domain.ActorKind(person.Sub)}
	if !domain.Can(actor, domain.SetStatus, domain.Target{Category: category, AgentCompletion: policy}) {
		return httpx.Forbidden()
	}
	return nil
}

func (t *Tx) delegation(person domain.Person, assignee *domain.Person, reporter string) (*domain.Person, error) {
	if assignee == nil || domain.ActorKind(assignee.Sub) != "agent" {
		return nil, nil
	}
	if _, err := t.AgentAssignee(assignee.Sub); err != nil {
		return nil, err
	}
	actor, err := t.issueActor(person)
	if err != nil {
		return nil, err
	}
	if !domain.Can(actor, domain.AssignAgent, domain.Target{OwnerSub: assignee.Sub, ReporterSub: reporter}) {
		return nil, httpx.Forbidden()
	}
	if actor.Kind == "agent" {
		return &actor.Agent.Owner, nil
	}
	return &person, nil
}

func (t *Tx) saveDelegator(id string, person *domain.Person) error {
	var sub, name any
	if person != nil {
		sub, name = person.Sub, person.Name
	}
	return t.Exec(`UPDATE tracker_issue SET delegator_sub=$3,delegator_name=$4 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, sub, name)
}
