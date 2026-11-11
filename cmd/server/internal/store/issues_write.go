package store

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

// Field distinguishes an omitted property from an explicit JSON null.
type Field[T any] struct {
	Present bool
	Value   *T
}

func (f *Field[T]) UnmarshalJSON(data []byte) error {
	f.Present = true
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&f.Value)
}

type IssueCreate struct {
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Type        string         `json:"type"`
	Priority    string         `json:"priority"`
	StatusID    string         `json:"statusId"`
	AssigneeSub *string        `json:"assigneeSub"`
	LabelIDs    []string       `json:"labelIds"`
	ProjectID   *string        `json:"projectId"`
	Estimate    *string        `json:"estimate"`
	SprintID    *string        `json:"sprintId"`
	ParentID    *string        `json:"parentId"`
	DueOn       *string        `json:"dueOn"`
	Report      *domain.Report `json:"report"`
}
type IssuePatch struct {
	Title       Field[string]        `json:"title"`
	Description Field[string]        `json:"description"`
	Type        Field[string]        `json:"type"`
	Priority    Field[string]        `json:"priority"`
	StatusID    Field[string]        `json:"statusId"`
	AssigneeSub Field[string]        `json:"assigneeSub"`
	LabelIDs    Field[[]string]      `json:"labelIds"`
	ProjectID   Field[string]        `json:"projectId"`
	Estimate    Field[string]        `json:"estimate"`
	SprintID    Field[string]        `json:"sprintId"`
	ParentID    Field[string]        `json:"parentId"`
	Blocks      Field[[]string]      `json:"blocks"`
	DueOn       Field[string]        `json:"dueOn"`
	Report      Field[domain.Report] `json:"report"`
}

func jsonValue(value any) (any, error) {
	if value == nil || (reflect.ValueOf(value).Kind() == reflect.Pointer && reflect.ValueOf(value).IsNil()) {
		return nil, nil
	}
	data, err := json.Marshal(value)
	return string(data), err
}
func (t *Tx) activity(issueID string, actor domain.Person, field string, from, to any) error {
	old, err := jsonValue(from)
	if err != nil {
		return err
	}
	next, err := jsonValue(to)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO tracker_activity (id,issue_id,actor_sub,actor_name,field,from_value,to_value) VALUES ($1,$2,$3,$4,$5,$6,$7)`, ulid.Make().String(), issueID, actor.Sub, actor.Name, field, old, next)
}
func ref(issue domain.Issue) domain.IssueRef {
	return domain.IssueRef{ID: issue.ID, Identifier: issue.Identifier, Title: issue.Title, StatusID: issue.StatusID}
}
func (t *Tx) parent(id, parentID, childType, path string) (*domain.IssueRef, error) {
	if parentID == "" {
		return nil, nil
	}
	if !domain.ValidID(parentID) {
		return nil, invalid("Parent must be an issue ID")
	}
	var parent domain.IssueRef
	var parentType string
	err := t.SQL.QueryRowContext(t.Context, `SELECT i.id,w.key||'-'||i.number,i.title,i.status_id,i.type`+issueFrom+`WHERE i.workspace_id=$1 AND i.id=$2 AND i.deleted_at IS NULL`, t.WorkspaceID, parentID).Scan(&parent.ID, &parent.Identifier, &parent.Title, &parent.StatusID, &parentType)
	if err != nil {
		return nil, invalid("Parent must be an existing issue in this workspace")
	}
	if err := domain.ValidateHierarchy(childType, parentType); err != nil {
		return nil, &domain.FieldError{Path: path, Message: err.Error()}
	}
	rows, err := t.SQL.QueryContext(t.Context, `WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM tracker_issue WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL UNION SELECT i.id,i.parent_id FROM tracker_issue i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL) SELECT id,coalesce(parent_id,'') FROM ancestors`, t.WorkspaceID, parentID)
	if err != nil {
		return nil, err
	}
	parents := map[string]string{}
	for rows.Next() {
		var child, p string
		if err := rows.Scan(&child, &p); err != nil {
			rows.Close()
			return nil, err
		}
		parents[child] = p
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if domain.ParentCycle(id, parentID, parents) {
		return nil, invalid("Parent would create a cycle")
	}
	return &parent, nil
}
func (t *Tx) validateChildren(id, parentType string) error {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT DISTINCT type FROM tracker_issue WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL`, t.WorkspaceID, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var childType string
		if err := rows.Scan(&childType); err != nil {
			return err
		}
		if err := domain.ValidateHierarchy(childType, parentType); err != nil {
			return &domain.FieldError{Path: "type", Message: err.Error()}
		}
	}
	return rows.Err()
}
func (t *Tx) replaceLabels(id string, ids []string) ([]string, error) {
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	if ids == nil {
		ids = []string{}
	}
	for _, labelID := range ids {
		if _, err := t.Label(labelID); err != nil {
			return nil, invalid("Labels must belong to this workspace")
		}
	}
	if err := t.Exec(`DELETE FROM tracker_issue_label WHERE issue_id=$1`, id); err != nil {
		return nil, err
	}
	for _, labelID := range ids {
		if err := t.Exec(`INSERT INTO tracker_issue_label (issue_id,label_id) VALUES ($1,$2)`, id, labelID); err != nil {
			return nil, err
		}
	}
	return ids, nil
}
func (t *Tx) replaceBlocks(id string, ids []string) ([]domain.IssueRef, error) {
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	items := make([]domain.IssueRef, 0, len(ids))
	for _, blocked := range ids {
		if !domain.ValidID(blocked) {
			return nil, invalid("Blocked issues must be issue IDs")
		}
		if blocked == id {
			return nil, invalid("An issue cannot block itself")
		}
		item, err := t.Issue(blocked)
		if err != nil {
			return nil, invalid("Blocked issues must belong to this workspace")
		}
		items = append(items, ref(item))
	}
	slices.SortFunc(items, func(a, b domain.IssueRef) int { return strings.Compare(a.ID, b.ID) })
	if err := t.Exec(`DELETE FROM tracker_issue_block WHERE blocker_id=$1`, id); err != nil {
		return nil, err
	}
	for _, blocked := range ids {
		if err := t.Exec(`INSERT INTO tracker_issue_block (blocker_id,blocked_id) VALUES ($1,$2)`, id, blocked); err != nil {
			return nil, err
		}
	}
	return items, nil
}
func (t *Tx) CreateIssue(input IssueCreate, actor domain.Person, assignee *domain.Person) (domain.Issue, error) {
	item := domain.Issue{IssueSummary: domain.IssueSummary{ID: ulid.Make().String(), Title: strings.TrimSpace(input.Title), Type: input.Type, Priority: input.Priority, StatusID: input.StatusID, Assignee: assignee, Reporter: actor, ProjectID: input.ProjectID, Estimate: input.Estimate, DueOn: input.DueOn, Report: input.Report}, Description: input.Description}
	if item.Priority == "" {
		item.Priority = "none"
	}
	if err := domain.ValidateIssue(item); err != nil {
		if _, ok := err.(*domain.FieldError); ok {
			return item, err
		}
		return item, invalid(err.Error())
	}
	if err := t.validateProjectAssignment(item.ProjectID); err != nil {
		return item, err
	}
	if item.StatusID == "" {
		if err := t.SQL.QueryRowContext(t.Context, `SELECT id FROM tracker_status WHERE workspace_id=$1 AND category='backlog' ORDER BY position,id LIMIT 1`, t.WorkspaceID).Scan(&item.StatusID); err != nil {
			return item, err
		}
	}
	status, err := t.Status(item.StatusID)
	if err != nil {
		return item, invalid("Status must belong to this workspace")
	}
	if err := t.completionAllowed(actor, status.Category); err != nil {
		return item, err
	}
	item.Delegator, err = t.delegation(actor, assignee, actor.Sub)
	if err != nil {
		return item, err
	}
	item.CompletedAt = domain.TransitionCompletedAt(status.Category, t.now())
	if input.ParentID != nil {
		item.Parent, err = t.parent(item.ID, *input.ParentID, item.Type, "parentId")
		if err != nil {
			return item, err
		}
	}
	item.Sprint, err = t.sprintRef(input.SprintID)
	if err != nil {
		return item, err
	}
	if err := t.validateSprintMembership(item); err != nil {
		return item, err
	}
	if err := t.SQL.QueryRowContext(t.Context, `UPDATE tracker_workspace SET issue_seq=issue_seq+1,updated_at=now() WHERE id=$1 RETURNING issue_seq`, t.WorkspaceID).Scan(&item.Number); err != nil {
		return item, err
	}
	report, err := jsonValue(item.Report)
	if err != nil {
		return item, err
	}
	var sub, name, parent any
	if assignee != nil {
		sub, name = assignee.Sub, assignee.Name
	}
	if item.Parent != nil {
		parent = item.Parent.ID
	}
	if err := t.Exec(`INSERT INTO tracker_issue (id,workspace_id,number,title,description,type,priority,status_id,assignee_sub,assignee_name,reporter_sub,reporter_name,parent_id,due_on,report,completed_at,project_id,estimate,sprint_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, item.ID, t.WorkspaceID, item.Number, item.Title, item.Description, item.Type, item.Priority, item.StatusID, sub, name, actor.Sub, actor.Name, parent, item.DueOn, report, item.CompletedAt, item.ProjectID, item.Estimate, sprintID(item.Sprint)); err != nil {
		return item, err
	}
	if err := t.saveDelegator(item.ID, item.Delegator); err != nil {
		return item, err
	}
	if _, err := t.replaceLabels(item.ID, input.LabelIDs); err != nil {
		return item, err
	}
	if err := t.activity(item.ID, actor, "created", nil, nil); err != nil {
		return item, err
	}
	after, err := t.standing(item)
	if err != nil {
		return item, err
	}
	if err := t.sprintEvents(item.ID, domain.SprintStanding{}, after); err != nil {
		return item, err
	}
	return t.Issue(item.ID)
}
func (t *Tx) PatchIssue(id string, input IssuePatch, actor domain.Person, assignee *domain.Person) (domain.Issue, error) {
	old, err := t.Issue(id)
	if err != nil {
		return old, err
	}
	item := old
	for _, field := range []struct {
		in  Field[string]
		out *string
	}{{input.Title, &item.Title}, {input.Description, &item.Description}, {input.Type, &item.Type}, {input.Priority, &item.Priority}, {input.StatusID, &item.StatusID}} {
		if field.in.Present {
			if field.in.Value == nil {
				return item, invalid("This field cannot be null")
			}
			*field.out = *field.in.Value
		}
	}
	item.Title = strings.TrimSpace(item.Title)
	if input.AssigneeSub.Present {
		item.Assignee = nil
		if assignee != nil {
			item.Assignee = &domain.Person{Sub: assignee.Sub, Name: assignee.Name}
		}
		item.Delegator, err = t.delegation(actor, assignee, item.Reporter.Sub)
		if err != nil {
			return item, err
		}
	}
	if input.ProjectID.Present {
		item.ProjectID = input.ProjectID.Value
		if !reflect.DeepEqual(old.ProjectID, item.ProjectID) {
			if err := t.validateProjectAssignment(item.ProjectID); err != nil {
				return item, err
			}
		}
	}
	if input.Estimate.Present {
		item.Estimate = input.Estimate.Value
	}
	if input.SprintID.Present {
		next, err := t.sprintRef(input.SprintID.Value)
		if err != nil {
			return item, err
		}
		if old.Sprint != nil && old.Sprint.State == "closed" {
			return item, &domain.FieldError{Path: "sprintId", Message: "Membership of a closed sprint is frozen"}
		}
		item.Sprint = next
	}
	if input.DueOn.Present {
		item.DueOn = input.DueOn.Value
	}
	if input.Report.Present {
		item.Report = input.Report.Value
	}
	if item.Type != "bug" && old.Type == "bug" && !input.Report.Present {
		item.Report = nil
	}
	if err := domain.ValidateIssue(item); err != nil {
		if _, ok := err.(*domain.FieldError); ok {
			return item, err
		}
		return item, invalid(err.Error())
	}
	if input.ParentID.Present || item.Type != old.Type {
		parent := ""
		if old.Parent != nil {
			parent = old.Parent.ID
		}
		oldParent := parent
		if input.ParentID.Present {
			parent = ""
			if input.ParentID.Value != nil {
				parent = *input.ParentID.Value
			}
		}
		path := "type"
		if parent != oldParent {
			path = "parentId"
		}
		item.Parent, err = t.parent(item.ID, parent, item.Type, path)
		if err != nil {
			return item, err
		}
		if err := t.validateChildren(item.ID, item.Type); err != nil {
			return item, err
		}
	}
	if input.SprintID.Present || input.ParentID.Present || item.Type != old.Type {
		if err := t.validateSprintMembership(item); err != nil {
			return item, err
		}
	}
	if input.StatusID.Present {
		after, err := t.Status(item.StatusID)
		if err != nil {
			return item, invalid("Status must belong to this workspace")
		}
		if err := t.completionAllowed(actor, after.Category); err != nil {
			return item, err
		}
		if item.StatusID != old.StatusID {
			item.CompletedAt = domain.TransitionCompletedAt(after.Category, t.now())
		}
	}
	if input.LabelIDs.Present {
		if input.LabelIDs.Value == nil {
			return item, invalid("labelIds cannot be null")
		}
		item.LabelIDs, err = t.replaceLabels(item.ID, *input.LabelIDs.Value)
		if err != nil {
			return item, err
		}
	}
	if input.Blocks.Present {
		if input.Blocks.Value == nil {
			return item, invalid("blocks cannot be null")
		}
		item.Blocks, err = t.replaceBlocks(item.ID, *input.Blocks.Value)
		if err != nil {
			return item, err
		}
		slices.SortFunc(old.Blocks, func(a, b domain.IssueRef) int { return strings.Compare(a.ID, b.ID) })
	}
	changed := false
	for _, field := range []struct {
		name     string
		from, to any
	}{
		{"title", old.Title, item.Title}, {"description", old.Description, item.Description}, {"type", old.Type, item.Type}, {"priority", old.Priority, item.Priority}, {"status", old.StatusID, item.StatusID}, {"assignee", old.Assignee, item.Assignee}, {"labels", old.LabelIDs, item.LabelIDs}, {"parent", old.Parent, item.Parent}, {"blocks", old.Blocks, item.Blocks}, {"due", old.DueOn, item.DueOn}, {"report", old.Report, item.Report},
		{"project", old.ProjectID, item.ProjectID},
		{"estimate", old.Estimate, item.Estimate}, {"sprint", old.Sprint, item.Sprint},
		{"delegator", old.Delegator, item.Delegator},
	} {
		if !reflect.DeepEqual(field.from, field.to) {
			changed = true
			if err := t.activity(item.ID, actor, field.name, field.from, field.to); err != nil {
				return item, err
			}
		}
	}
	if !changed {
		return old, nil
	}
	var sub, name, parent any
	if item.Assignee != nil {
		sub, name = item.Assignee.Sub, item.Assignee.Name
	}
	if item.Parent != nil {
		parent = item.Parent.ID
	}
	report, err := jsonValue(item.Report)
	if err != nil {
		return item, err
	}
	if err := t.Exec(`UPDATE tracker_issue SET title=$3,description=$4,type=$5,priority=$6,status_id=$7,assignee_sub=$8,assignee_name=$9,parent_id=$10,due_on=$11,report=$12,completed_at=$13,project_id=$14,estimate=$15,sprint_id=$16,updated_at=now() WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, item.ID, item.Title, item.Description, item.Type, item.Priority, item.StatusID, sub, name, parent, item.DueOn, report, item.CompletedAt, item.ProjectID, item.Estimate, sprintID(item.Sprint)); err != nil {
		return item, err
	}
	if err := t.saveDelegator(item.ID, item.Delegator); err != nil {
		return item, err
	}
	if input.AssigneeSub.Present && old.Assignee != nil && domain.ActorKind(old.Assignee.Sub) == "agent" &&
		(item.Assignee == nil || item.Assignee.Sub != old.Assignee.Sub) &&
		old.ActiveRun != nil && old.ActiveRun.Agent.Sub == old.Assignee.Sub {
		if err := t.closeRun(old.ActiveRun.ID, "canceled", "reassigned"); err != nil {
			return item, err
		}
	}
	before, err := t.standing(old)
	if err != nil {
		return item, err
	}
	after, err := t.standing(item)
	if err != nil {
		return item, err
	}
	if err := t.sprintEvents(item.ID, before, after); err != nil {
		return item, err
	}
	return t.Issue(item.ID)
}
func (t *Tx) DeleteIssue(id string, actor domain.Actor) error {
	if !domain.Can(actor, domain.DeleteIssue, domain.Target{}) {
		return httpx.Forbidden()
	}
	item, err := t.Issue(id)
	if err != nil {
		return err
	}
	if err := t.Exec(`UPDATE tracker_issue SET deleted_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, item.ID); err != nil {
		return err
	}
	before, err := t.standing(item)
	if err != nil {
		return err
	}
	after := before
	after.Deleted = true
	if err := t.sprintEvents(item.ID, before, after); err != nil {
		return err
	}
	return t.activity(item.ID, actor.Person, "deleted", nil, nil)
}
