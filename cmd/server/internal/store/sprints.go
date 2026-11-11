package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

type SprintCreate struct {
	Name        *string `json:"name"`
	Goal        *string `json:"goal"`
	StartsOn    *string `json:"startsOn"`
	LengthWeeks *int    `json:"lengthWeeks"`
}
type SprintPatch = SprintCreate

const sprintStateSQL = `(CASE WHEN s.closed_at IS NOT NULL THEN 'closed' WHEN s.started_at IS NOT NULL THEN 'active' ELSE 'planned' END)`
const sprintColumns = `s.id,s.number,s.name,s.goal,` + sprintStateSQL + `,s.length_weeks,to_char(s.starts_on,'YYYY-MM-DD'),to_char(s.ends_on,'YYYY-MM-DD'),s.started_at,s.closed_at,s.created_at,s.updated_at`

func scanSprint(row scanner) (domain.Sprint, error) {
	var s domain.Sprint
	err := row.Scan(&s.ID, &s.Number, &s.Name, &s.Goal, &s.State, &s.LengthWeeks, &s.StartsOn, &s.EndsOn, &s.StartedAt, &s.ClosedAt, &s.CreatedAt, &s.UpdatedAt)
	s.CreatedAt, s.UpdatedAt = s.CreatedAt.UTC(), s.UpdatedAt.UTC()
	if s.StartedAt != nil {
		v := s.StartedAt.UTC()
		s.StartedAt = &v
	}
	if s.ClosedAt != nil {
		v := s.ClosedAt.UTC()
		s.ClosedAt = &v
	}
	return s, err
}
func (t *Tx) sprintTotals(s *domain.Sprint) error {
	var err error
	s.Current, err = t.sprintTally(s.ID, s.ClosedAt, "")
	if err != nil {
		return err
	}
	if s.StartedAt != nil {
		v, err := t.sprintTally(s.ID, s.StartedAt, "")
		if err != nil {
			return err
		}
		s.Commitment = &v
	}
	return nil
}
func (t *Tx) Sprint(id string) (domain.Sprint, error) {
	s, err := scanSprint(t.SQL.QueryRowContext(t.Context, `SELECT `+sprintColumns+` FROM tracker_sprint s WHERE s.workspace_id=$1 AND s.id=$2`, t.WorkspaceID, id))
	if err == nil {
		err = t.sprintTotals(&s)
	}
	return s, err
}
func (t *Tx) Sprints(state string) ([]domain.Sprint, error) {
	if state != "" && state != "planned" && state != "active" && state != "closed" {
		return nil, &domain.FieldError{Path: "state", Message: "State must be planned, active, or closed"}
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+sprintColumns+` FROM tracker_sprint s WHERE s.workspace_id=$1 AND ($2='' OR `+sprintStateSQL+`=$2) ORDER BY CASE WHEN s.closed_at IS NOT NULL THEN 2 WHEN s.started_at IS NOT NULL THEN 0 ELSE 1 END,CASE WHEN s.closed_at IS NULL THEN s.starts_on END, s.closed_at DESC,s.number DESC`, t.WorkspaceID, state)
	if err != nil {
		return nil, err
	}
	result := []domain.Sprint{}
	for rows.Next() {
		s, err := scanSprint(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		if err := t.sprintTotals(&result[i]); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func (t *Tx) sprintTally(id string, at *time.Time, project string) (domain.Tally, error) {
	var v domain.Tally
	err := t.SQL.QueryRowContext(t.Context, `SELECT coalesce(sum(e.scope_points),0),coalesce(sum(e.scope_issues),0),coalesce(sum(e.done_points),0),coalesce(sum(e.done_issues),0) FROM tracker_sprint_event e JOIN tracker_issue i ON i.id=e.issue_id JOIN tracker_sprint s ON s.id=e.sprint_id WHERE s.workspace_id=$1 AND s.id=$2 AND ($3::timestamptz IS NULL OR e.at<=$3) AND ($4='' OR ($4='none' AND i.project_id IS NULL) OR i.project_id=$4)`, t.WorkspaceID, id, at, project).Scan(&v.ScopePoints, &v.ScopeIssues, &v.DonePoints, &v.DoneIssues)
	return v, err
}
func (t *Tx) sprintDates(id, start string, weeks int) (string, error) {
	day, err := time.Parse("2006-01-02", start)
	if err != nil {
		return "", &domain.FieldError{Path: "startsOn", Message: "Start date must be YYYY-MM-DD"}
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT starts_on,ends_on FROM tracker_sprint WHERE workspace_id=$1 AND id<>$2 AND closed_at IS NULL`, t.WorkspaceID, id)
	if err != nil {
		return "", err
	}
	spans := []domain.SprintSpan{}
	for rows.Next() {
		var span domain.SprintSpan
		if err := rows.Scan(&span.StartsOn, &span.EndsOn); err != nil {
			rows.Close()
			return "", err
		}
		spans = append(spans, span)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	if err := domain.ValidateSprintDates(day, weeks, spans); err != nil {
		if errors.Is(err, domain.ErrSprintOverlap) {
			return "", httpx.Conflict(err.Error())
		}
		return "", err
	}
	return day.AddDate(0, 0, 7*weeks-1).Format("2006-01-02"), nil
}
func validateSprint(s domain.Sprint) error {
	if !domain.Text(s.Name, 1, 60) {
		return &domain.FieldError{Path: "name", Message: "Sprint name must contain 1 to 60 characters"}
	}
	if !utf8.ValidString(s.Goal) || len(s.Goal) > 4096 {
		return &domain.FieldError{Path: "goal", Message: "Sprint goal must be valid UTF-8 and at most 4096 bytes"}
	}
	return nil
}
func (t *Tx) CreateSprint(input SprintCreate) (domain.Sprint, error) {
	var s domain.Sprint
	w, err := t.Workspace()
	if err != nil {
		return s, err
	}
	s.ID = ulid.Make().String()
	s.LengthWeeks = w.SprintLengthWeeks
	if input.LengthWeeks != nil {
		s.LengthWeeks = *input.LengthWeeks
	}
	if input.StartsOn != nil {
		s.StartsOn = *input.StartsOn
	} else {
		var latest sql.NullTime
		if err := t.SQL.QueryRowContext(t.Context, `SELECT max(ends_on) FROM tracker_sprint WHERE workspace_id=$1 AND closed_at IS NULL`, t.WorkspaceID).Scan(&latest); err != nil {
			return s, err
		}
		if latest.Valid {
			s.StartsOn = latest.Time.AddDate(0, 0, 1).Format("2006-01-02")
		} else {
			loc, err := time.LoadLocation(w.Timezone)
			if err != nil {
				return s, err
			}
			today := t.now().In(loc)
			days := (int(time.Monday) - int(today.Weekday()) + 7) % 7
			if days == 0 {
				days = 7
			}
			s.StartsOn = today.AddDate(0, 0, days).Format("2006-01-02")
		}
	}
	s.EndsOn, err = t.sprintDates(s.ID, s.StartsOn, s.LengthWeeks)
	if err != nil {
		return s, err
	}
	if err := t.SQL.QueryRowContext(t.Context, `UPDATE tracker_workspace SET sprint_seq=sprint_seq+1 WHERE id=$1 RETURNING sprint_seq`, t.WorkspaceID).Scan(&s.Number); err != nil {
		return s, err
	}
	s.Name = fmt.Sprintf("Sprint %d", s.Number)
	if input.Name != nil {
		s.Name = strings.TrimSpace(*input.Name)
	}
	if input.Goal != nil {
		s.Goal = *input.Goal
	}
	if err := validateSprint(s); err != nil {
		return s, err
	}
	now := t.now()
	if err := t.Exec(`INSERT INTO tracker_sprint (id,workspace_id,number,name,goal,length_weeks,starts_on,ends_on,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, s.ID, t.WorkspaceID, s.Number, s.Name, s.Goal, s.LengthWeeks, s.StartsOn, s.EndsOn, now); err != nil {
		return s, err
	}
	return t.Sprint(s.ID)
}
func (t *Tx) PatchSprint(id string, input SprintPatch) (domain.Sprint, error) {
	s, err := t.Sprint(id)
	if err != nil {
		return s, err
	}
	if input.StartsOn != nil || input.LengthWeeks != nil {
		if s.State != "planned" {
			return s, httpx.Conflict("Only planned sprints can be re-dated")
		}
		if input.StartsOn != nil {
			s.StartsOn = *input.StartsOn
		}
		if input.LengthWeeks != nil {
			s.LengthWeeks = *input.LengthWeeks
		}
		s.EndsOn, err = t.sprintDates(id, s.StartsOn, s.LengthWeeks)
		if err != nil {
			return s, err
		}
	}
	if input.Name != nil {
		s.Name = strings.TrimSpace(*input.Name)
	}
	if input.Goal != nil {
		s.Goal = *input.Goal
	}
	if err := validateSprint(s); err != nil {
		return s, err
	}
	if err := t.Exec(`UPDATE tracker_sprint SET name=$3,goal=$4,length_weeks=$5,starts_on=$6,ends_on=$7,updated_at=$8 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, s.Name, s.Goal, s.LengthWeeks, s.StartsOn, s.EndsOn, t.now()); err != nil {
		return s, err
	}
	return t.Sprint(id)
}
func (t *Tx) StartSprint(id string) (domain.Sprint, error) {
	s, err := t.Sprint(id)
	if err != nil {
		return s, err
	}
	if s.State != "planned" {
		return s, httpx.Conflict("Only planned sprints can be started")
	}
	var active bool
	if err := t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM tracker_sprint WHERE workspace_id=$1 AND started_at IS NOT NULL AND closed_at IS NULL)`, t.WorkspaceID).Scan(&active); err != nil {
		return s, err
	}
	if active {
		return s, httpx.Conflict("Another sprint is active")
	}
	w, err := t.Workspace()
	if err != nil {
		return s, err
	}
	loc, err := time.LoadLocation(w.Timezone)
	if err != nil {
		return s, err
	}
	now := t.now()
	today := now.In(loc).Format("2006-01-02")
	if s.StartsOn > today {
		s.StartsOn = today
	}
	s.EndsOn, err = t.sprintDates(id, s.StartsOn, s.LengthWeeks)
	if err != nil {
		return s, err
	}
	if err := t.Exec(`UPDATE tracker_sprint SET started_at=$3,starts_on=$4,ends_on=$5,updated_at=$3 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, now, s.StartsOn, s.EndsOn); err != nil {
		return s, err
	}
	return t.Sprint(id)
}
func (t *Tx) CloseSprint(id string, target *string, actor domain.Person) (domain.Sprint, error) {
	s, err := t.Sprint(id)
	if err != nil {
		return s, err
	}
	if s.State != "active" {
		return s, httpx.Conflict("Only active sprints can be closed")
	}
	var next *domain.SprintRef
	if target != nil {
		v, err := t.Sprint(*target)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return s, &domain.FieldError{Path: "moveIncompleteTo", Message: "Target must be a planned sprint in this workspace"}
			}
			return s, err
		}
		if v.State != "planned" {
			return s, &domain.FieldError{Path: "moveIncompleteTo", Message: "Target must be a planned sprint in this workspace"}
		}
		next = &v.SprintRef
	}
	members, err := t.sprintMembers(id, true)
	if err != nil {
		return s, err
	}
	if err := t.Exec(`UPDATE tracker_sprint SET closed_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, t.now()); err != nil {
		return s, err
	}
	for _, item := range members {
		destination := next
		candidate := item
		candidate.Sprint = destination
		if err := t.validateSprintMembership(candidate); err != nil {
			var field *domain.FieldError
			if !errors.As(err, &field) || field.Path != "sprintId" {
				return s, err
			}
			destination = nil
		}
		if err := t.moveSprintMember(item, destination, actor); err != nil {
			return s, err
		}
	}
	return t.Sprint(id)
}
func (t *Tx) DeleteSprint(id string, actor domain.Actor) error {
	if !domain.Can(actor, domain.ManageWorkspace, domain.Target{}) {
		return httpx.Forbidden()
	}
	s, err := t.Sprint(id)
	if err != nil {
		return err
	}
	if s.State != "planned" {
		return httpx.Conflict("Only planned sprints can be deleted")
	}
	members, err := t.sprintMembers(id, false)
	if err != nil {
		return err
	}
	for _, item := range members {
		if err := t.moveSprintMember(item, nil, actor.Person); err != nil {
			return err
		}
	}
	// Soft-deleted members also retain a foreign key until the sprint is removed.
	if err := t.Exec(`UPDATE tracker_issue SET sprint_id=NULL WHERE workspace_id=$1 AND sprint_id=$2`, t.WorkspaceID, id); err != nil {
		return err
	}
	return t.Exec(`DELETE FROM tracker_sprint WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id)
}
func (t *Tx) sprintMembers(id string, incomplete bool) ([]domain.Issue, error) {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT i.id FROM tracker_issue i JOIN tracker_status s ON s.id=i.status_id WHERE i.workspace_id=$1 AND i.sprint_id=$2 AND i.deleted_at IS NULL AND (NOT $3 OR s.category NOT IN ('completed','canceled')) ORDER BY i.id`, t.WorkspaceID, id, incomplete)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	result := make([]domain.Issue, 0, len(ids))
	for _, id := range ids {
		item, err := t.Issue(id)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}
func (t *Tx) moveSprintMember(item domain.Issue, next *domain.SprintRef, actor domain.Person) error {
	before, err := t.standing(item)
	if err != nil {
		return err
	}
	old := item.Sprint
	item.Sprint = next
	after := before
	after.SprintID = ""
	var id any
	if next != nil {
		after.SprintID = next.ID
		id = next.ID
	}
	if err := t.Exec(`UPDATE tracker_issue SET sprint_id=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, item.ID, id, t.now()); err != nil {
		return err
	}
	if err := t.sprintEvents(item.ID, before, after); err != nil {
		return err
	}
	if err := t.activity(item.ID, actor, "sprint", old, next); err != nil {
		return err
	}
	return t.event(item.ID, actor, "issue.updated", map[string]any{"fields": []string{"sprint"}})
}
