package store

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

const agentColumns = `a.id,a.handle,a.name,a.description,a.owner_sub,a.owner_name,a.disabled,a.created_at,a.updated_at,
 (SELECT count(*) FROM tracker_run r JOIN tracker_issue i ON i.id=r.issue_id WHERE r.agent_id=a.id AND i.deleted_at IS NULL AND r.state IN ('running','waiting') AND r.lease_expires_at >= $2),
 (SELECT count(*) FROM tracker_request q JOIN tracker_issue i ON i.id=q.issue_id WHERE i.workspace_id=a.workspace_id AND i.deleted_at IS NULL AND q.from_sub='agent:'||a.id AND q.state='open'),
 a.last_seen_at`

func scanAgent(row scanner) (domain.Agent, error) {
	var a domain.Agent
	err := row.Scan(&a.ID, &a.Handle, &a.Name, &a.Description, &a.Owner.Sub, &a.Owner.Name, &a.Disabled, &a.CreatedAt, &a.UpdatedAt, &a.ActiveRuns, &a.OpenRequests, &a.LastSeenAt)
	return a, err
}

func (t *Tx) Agent(id string) (domain.Agent, error) {
	return scanAgent(t.SQL.QueryRowContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND a.id=$3`, t.WorkspaceID, t.now(), id))
}

func (t *Tx) AgentBySubject(subject string) (domain.Actor, error) {
	a, err := scanAgent(t.SQL.QueryRowContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND a.handle=$3 AND NOT a.disabled`, t.WorkspaceID, t.now(), subject))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Actor{}, httpx.Fail(403, "key_subject", "The access key subject is not an active registered agent")
	}
	if err != nil {
		return domain.Actor{}, err
	}
	return domain.Actor{Person: a.Person(), Kind: "agent", AgentID: a.ID, Role: "Viewer", Key: true}, nil
}

func (t *Tx) Agents(includeDisabled bool) ([]domain.Agent, error) {
	list := []domain.Agent{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+agentColumns+` FROM tracker_agent a WHERE a.workspace_id=$1 AND ($3 OR NOT a.disabled) ORDER BY a.handle`, t.WorkspaceID, t.now(), includeDisabled)
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
	if !domain.Text(owner.Sub, 1, 4096) || domain.ActorKind(owner.Sub) != "person" {
		return domain.Agent{}, invalid("An agent owner must be a person")
	}
	id := ulid.Make().String()
	if err := t.Exec(`INSERT INTO tracker_agent(id,workspace_id,handle,name,description,owner_sub,owner_name) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, t.WorkspaceID, input.Handle, strings.TrimSpace(input.Name), input.Description, owner.Sub, owner.Name); err != nil {
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

type AgentPatch struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	OwnerSub    *string `json:"ownerSub"`
	Disabled    *bool   `json:"disabled"`
}

func (t *Tx) PatchAgent(id string, input AgentPatch, owner *domain.Person, actor domain.Actor) (domain.Agent, error) {
	if !domain.Can(actor, domain.ManageWorkspace, domain.Target{}) {
		return domain.Agent{}, httpx.Forbidden()
	}
	a, err := t.Agent(id)
	if err != nil {
		return a, err
	}
	if input.Name != nil {
		a.Name = strings.TrimSpace(*input.Name)
	}
	if input.Description != nil {
		a.Description = *input.Description
	}
	if owner != nil {
		a.Owner = *owner
	}
	if input.Disabled != nil {
		a.Disabled = *input.Disabled
	}
	if !domain.Text(a.Name, 1, 200) || len(a.Description) > 4096 || !domain.Text(a.Description, 0, 4096) {
		return a, invalid("Invalid agent name or description")
	}
	if !domain.Text(a.Owner.Sub, 1, 4096) || domain.ActorKind(a.Owner.Sub) != "person" {
		return a, invalid("An agent owner must be a person")
	}
	if err := t.Exec(`UPDATE tracker_agent SET name=$3,description=$4,owner_sub=$5,owner_name=$6,disabled=$7,updated_at=$8 WHERE workspace_id=$1 AND id=$2`,
		t.WorkspaceID, id, a.Name, a.Description, a.Owner.Sub, a.Owner.Name, a.Disabled, t.now()); err != nil {
		return a, err
	}
	if a.Disabled {
		rows, err := t.SQL.QueryContext(t.Context, `SELECT r.id FROM tracker_run r JOIN tracker_issue i ON i.id=r.issue_id WHERE i.workspace_id=$1 AND r.agent_id=$2 AND r.state IN ('running','waiting') ORDER BY r.id`, t.WorkspaceID, id)
		if err != nil {
			return a, err
		}
		ids := []string{}
		for rows.Next() {
			var runID string
			if err := rows.Scan(&runID); err != nil {
				rows.Close()
				return a, err
			}
			ids = append(ids, runID)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return a, err
		}
		for _, runID := range ids {
			if err := t.closeRun(runID, "canceled", "canceled_by:"+actor.Sub, actor.Person); err != nil {
				return a, err
			}
		}
		if err := t.withdrawRequests(`q.from_sub=$2`, "agent:"+id, actor.Person); err != nil {
			return a, err
		}
	}
	return t.Agent(id)
}

// ObserveAgent is called after assertion authentication, including GET requests.
// The predicate bounds writes to once per minute across every key for a handle.
func (t *Tx) ObserveAgent(handle string) error {
	return t.Exec(`UPDATE tracker_agent SET last_seen_at=$3 WHERE workspace_id=$1 AND handle=$2 AND NOT disabled AND (last_seen_at IS NULL OR last_seen_at <= $3::timestamptz - interval '1 minute')`, t.WorkspaceID, handle, t.now())
}
