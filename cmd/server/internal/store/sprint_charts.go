package store

import (
	"math"
	"time"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
)

func chartOptions(unit, project string) (string, error) {
	if unit == "" {
		unit = "points"
	}
	if unit != "points" && unit != "issues" {
		return "", &domain.FieldError{Path: "unit", Message: "Unit must be points or issues"}
	}
	if project != "" && project != "none" && !domain.ValidID(project) {
		return "", &domain.FieldError{Path: "project", Message: "Project must be an ID or none"}
	}
	return unit, nil
}
func (t *Tx) Burndown(id, unit, project string) (domain.BurndownResponse, error) {
	var result domain.BurndownResponse
	unit, err := chartOptions(unit, project)
	if err != nil {
		return result, err
	}
	s, err := t.Sprint(id)
	if err != nil {
		return result, err
	}
	w, err := t.Workspace()
	if err != nil {
		return result, err
	}
	loc, err := time.LoadLocation(w.Timezone)
	if err != nil {
		return result, err
	}
	now := t.now()
	today := now.In(loc).Format("2006-01-02")
	start, err := time.ParseInLocation("2006-01-02", s.StartsOn, loc)
	if err != nil {
		return result, err
	}
	end, err := time.ParseInLocation("2006-01-02", s.EndsOn, loc)
	if err != nil {
		return result, err
	}
	days := make([]domain.Day, 0, 7*s.LengthWeeks)
	for date := start; !date.After(end); date = date.AddDate(0, 0, 1) {
		until := date.AddDate(0, 0, 1)
		if date.Format("2006-01-02") == today {
			until = now.Add(time.Nanosecond)
		}
		// An overdue sprint's final point includes its eventual close, not just
		// the scheduled last midnight. Earlier points keep their day boundaries.
		if s.ClosedAt != nil && (until.After(*s.ClosedAt) || date.Equal(end)) {
			until = s.ClosedAt.Add(time.Nanosecond)
		}
		days = append(days, domain.Day{Date: date, Until: until, Future: date.Format("2006-01-02") > today, Unit: unit})
	}
	baseline, err := t.sprintTally(id, s.StartedAt, project)
	if err != nil {
		return result, err
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT e.at,e.scope_points,e.scope_issues,e.done_points,e.done_issues FROM tracker_sprint_event e JOIN tracker_issue i ON i.id=e.issue_id WHERE e.sprint_id=$1 AND i.workspace_id=$2 AND ($3='' OR ($3='none' AND i.project_id IS NULL) OR i.project_id=$3) AND e.at<=$4 AND ($5::timestamptz IS NULL OR e.at<=$5) ORDER BY e.at,e.id`, id, t.WorkspaceID, project, now, s.ClosedAt)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	events := []domain.SprintEvent{}
	for rows.Next() {
		var e domain.SprintEvent
		if err := rows.Scan(&e.At, &e.ScopePoints, &e.ScopeIssues, &e.DonePoints, &e.DoneIssues); err != nil {
			return result, err
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	return domain.BurndownResponse{Sprint: s.SprintRef, Unit: unit, Today: today, Points: domain.Burndown(baseline, events, days)}, nil
}
func (t *Tx) Velocity(unit, project string, limit int) (domain.Velocity, error) {
	result := domain.Velocity{Items: []domain.VelocityEntry{}}
	unit, err := chartOptions(unit, project)
	if err != nil {
		return result, err
	}
	result.Unit = unit
	if limit == 0 {
		limit = 8
	}
	if limit < 1 || limit > 26 {
		return result, &domain.FieldError{Path: "limit", Message: "Limit must be between 1 and 26"}
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+sprintColumns+` FROM tracker_sprint s WHERE s.workspace_id=$1 AND s.closed_at IS NOT NULL ORDER BY s.closed_at DESC,s.number DESC LIMIT $2`, t.WorkspaceID, max(limit, 3))
	if err != nil {
		return result, err
	}
	sprints := []domain.Sprint{}
	for rows.Next() {
		s, err := scanSprint(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		sprints = append(sprints, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	average := 0.0
	for i, s := range sprints {
		committed, err := t.sprintTally(s.ID, s.StartedAt, project)
		if err != nil {
			return result, err
		}
		completed, err := t.sprintTally(s.ID, s.ClosedAt, project)
		if err != nil {
			return result, err
		}
		entry := domain.VelocityEntry{Sprint: s.SprintRef, LengthWeeks: s.LengthWeeks, Committed: committed.ScopePoints, Completed: completed.DonePoints}
		if unit == "issues" {
			entry.Committed = committed.ScopeIssues
			entry.Completed = completed.DoneIssues
		}
		if i < 3 {
			average += float64(entry.Completed) / float64(s.LengthWeeks)
		}
		if i < limit {
			result.Items = append(result.Items, entry)
		}
	}
	if len(sprints) > 0 {
		average = math.Round(average/float64(min(3, len(sprints)))*100) / 100
		result.AveragePerWeek = &average
	}
	for i, j := 0, len(result.Items)-1; i < j; i, j = i+1, j-1 {
		result.Items[i], result.Items[j] = result.Items[j], result.Items[i]
	}
	return result, nil
}
