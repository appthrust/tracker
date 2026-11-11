package store

import (
	"database/sql"
	"errors"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

func (t *Tx) sprintRef(id *string) (*domain.SprintRef, error) {
	if id == nil {
		return nil, nil
	}
	var s domain.SprintRef
	err := t.SQL.QueryRowContext(t.Context, `SELECT s.id,s.number,s.name,`+sprintStateSQL+` FROM tracker_sprint s WHERE s.workspace_id=$1 AND s.id=$2`, t.WorkspaceID, *id).Scan(&s.ID, &s.Number, &s.Name, &s.State)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &domain.FieldError{Path: "sprintId", Message: "Sprint must be planned or active in this workspace"}
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}
func (t *Tx) validateSprintMembership(item domain.Issue) error {
	parent, sprint := "", ""
	if item.Parent != nil {
		parent = item.Parent.ID
	}
	if item.Sprint != nil {
		sprint = item.Sprint.ID
		if err := domain.ValidateMembership(item.Type, item.Sprint.State, 0); err != nil {
			return err
		}
	}
	// Include the proposed root in the descendant set: reparenting an unassigned
	// intermediate node must not bring two existing members into one lineage.
	var conflicts int
	err := t.SQL.QueryRowContext(t.Context, `WITH RECURSIVE ancestors AS (
 SELECT id,parent_id,sprint_id FROM tracker_issue WHERE workspace_id=$1 AND id=$3 AND deleted_at IS NULL
 UNION SELECT i.id,i.parent_id,i.sprint_id FROM tracker_issue i JOIN ancestors a ON i.id=a.parent_id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL
 ), descendants AS (
 SELECT $2::text AS id,nullif($4::text,'') AS sprint_id
 UNION SELECT i.id,i.sprint_id FROM tracker_issue i JOIN descendants d ON i.parent_id=d.id WHERE i.workspace_id=$1 AND i.deleted_at IS NULL
 ) SELECT (SELECT count(*) FROM ancestors a JOIN descendants d ON a.sprint_id=d.sprint_id) + (SELECT count(*) FROM descendants d WHERE d.id<>$2 AND d.sprint_id=nullif($4,''))`, t.WorkspaceID, item.ID, parent, sprint).Scan(&conflicts)
	if err != nil {
		return err
	}
	if conflicts != 0 {
		return &domain.FieldError{Path: "sprintId", Message: "An ancestor or descendant already belongs to this sprint"}
	}
	return nil
}
func (t *Tx) standing(item domain.Issue) (domain.SprintStanding, error) {
	var s domain.SprintStanding
	if item.Sprint == nil {
		return s, nil
	}
	s.SprintID = item.Sprint.ID
	if item.Estimate != nil {
		s.Size = *item.Estimate
	}
	status, err := t.Status(item.StatusID)
	s.Category = status.Category
	return s, err
}
func (t *Tx) sprintEvents(issueID string, before, after domain.SprintStanding) error {
	for id, d := range domain.SprintDeltas(before, after) {
		if err := t.Exec(`INSERT INTO tracker_sprint_event (id,sprint_id,issue_id,at,scope_points,scope_issues,done_points,done_issues) SELECT $1,s.id,$3,$4,$5,$6,$7,$8 FROM tracker_sprint s WHERE s.workspace_id=$9 AND s.id=$2 AND s.closed_at IS NULL`, ulid.Make().String(), id, issueID, t.now(), d.ScopePoints, d.ScopeIssues, d.DonePoints, d.DoneIssues, t.WorkspaceID); err != nil {
			return err
		}
	}
	return nil
}
func sprintID(s *domain.SprintRef) any {
	if s == nil {
		return nil
	}
	return s.ID
}
