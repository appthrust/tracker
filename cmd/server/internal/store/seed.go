package store

import (
	"context"
	"fmt"
	"time"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

// SeedDev only fills an installation with no allocated issues, including deleted
// issues. It never repopulates an installation an administrator has emptied.
func (s *Store) SeedDev(ctx context.Context, workspace string) error {
	return s.InWorkspace(ctx, workspace, true, func(tx *Tx) error {
		if err := tx.EnsureWorkspace(); err != nil {
			return err
		}
		var sequence int64
		if err := tx.SQL.QueryRowContext(ctx, `SELECT issue_seq FROM tracker_workspace WHERE id=$1`, workspace).Scan(&sequence); err != nil {
			return err
		}
		if sequence != 0 {
			return nil
		}
		people := []domain.Person{{Sub: "dev-alex", Name: "Alex Chen"}, {Sub: "dev-sam", Name: "Sam Rivera"}, {Sub: "dev-jordan", Name: "Jordan Lee"}}
		admin := domain.Actor{Person: people[0], Role: "Admin"}
		projects := make([]domain.Project, 0, 3)
		for _, input := range []domain.Project{{Name: "Dashboard", Color: "blue"}, {Name: "Platform API", Color: "purple"}, {Name: "Builder Console", Color: "orange"}} {
			item, err := tx.CreateProject(ProjectCreate{Name: input.Name, Color: &input.Color}, admin)
			if err != nil {
				return err
			}
			projects = append(projects, item)
		}
		labels := []domain.Label{}
		for _, input := range []domain.Label{{Name: "regression", Color: "red"}, {Name: "ux", Color: "purple"}, {Name: "docs", Color: "blue"}} {
			item, err := tx.CreateLabel(input.Name, input.Color)
			if err != nil {
				return err
			}
			labels = append(labels, item)
		}
		statuses, err := tx.Statuses()
		if err != nil {
			return err
		}
		titles := []string{"Dashboard loses filters on reload", "Add keyboard shortcuts to issue list", "Document cluster recovery steps", "Platform API returns stale status", "Improve deployment progress display", "Update CLI quickstart", "Console app screenshot upload fails", "Add assignee picker search", "Review Gateway access documentation", "Cluster provisioning stalls", "Improve empty-state guidance", "Document release identity", "Dashboard sidebar overlaps content", "Add board column counts", "Clean up old fixtures", "CLI login expires too early", "Improve report form validation", "Document attachment limits", "Builder Console fails to load logs", "Add saved view navigation", "Review issue triage process", "Platform API pagination skips items", "Improve status colors", "Document Directory integration", "Console app reload loses state", "Add copy identifier action", "Review accessibility labels", "Cluster status is delayed", "Improve mobile issue detail", "Document workspace settings"}
		workTypes := []string{"bug", "feature", "task"}
		issues := make([]domain.Issue, 0, len(titles))
		for i, title := range titles {
			kind := workTypes[i%len(workTypes)]
			input := IssueCreate{Title: title, Description: fmt.Sprintf("Track and investigate this AppThrust work item.\n\nFixture issue %d.", i+1), Type: kind, Priority: domain.Priorities[i%len(domain.Priorities)], StatusID: statuses[i%len(statuses)].ID, LabelIDs: []string{labels[i%len(labels)].ID}}
			n := i + 1
			if n%3 != 0 {
				input.ProjectID = &projects[(n%3+n%2)%3].ID
			}
			if kind == "bug" {
				input.Report = &domain.Report{Environment: []string{"appthrust.ink", "craftsman", "appthrust.dev", "local"}[i%4], Surface: domain.Surfaces[i%len(domain.Surfaces)], Version: "0.1.0", Steps: "Open the affected surface and repeat the action.", Expected: "The action completes successfully.", Actual: "The observed behavior differs from the expected result."}
			}
			assignee := people[(i+1)%len(people)]
			item, err := tx.CreateIssue(input, people[i%len(people)], &assignee)
			if err != nil {
				return err
			}
			issues = append(issues, item)
		}
		epics := make([]domain.Issue, 0, 2)
		for _, title := range []string{"Reliable bug intake", "Faster triage"} {
			item, err := tx.CreateIssue(IssueCreate{Title: title, Type: "epic", Priority: "medium", StatusID: statuses[2].ID}, admin.Person, nil)
			if err != nil {
				return err
			}
			epics = append(epics, item)
		}
		stories := make([]domain.Issue, 0, 4)
		for i, title := range []string{"As a reporter, I want to submit a complete bug report", "As a triager, I want to reproduce reported bugs", "As a triager, I want to prioritize incoming work", "As an assignee, I want to find my next task"} {
			item, err := tx.CreateIssue(IssueCreate{Title: title, Type: "story", Priority: "medium", StatusID: statuses[2].ID, ParentID: &epics[i/2].ID}, admin.Person, nil)
			if err != nil {
				return err
			}
			stories = append(stories, item)
		}
		for i, issue := range issues {
			n := i + 1
			if n%5 != 0 {
				parent := stories[n%4].ID
				if _, err := tx.PatchIssue(issue.ID, IssuePatch{ParentID: Field[string]{Present: true, Value: &parent}}, admin.Person, nil); err != nil {
					return err
				}
			}
		}
		groupBy := "epic"
		for _, input := range []ViewCreate{{Name: "Bugs", Shared: true, Filter: domain.Filter{Type: []string{"bug"}}}, {Name: "My issues", Shared: true, Filter: domain.Filter{Assignee: []string{"me"}}}, {Name: "By epic", Shared: true, Layout: "board", GroupBy: &groupBy}} {
			if _, err := tx.CreateView(input, admin); err != nil {
				return err
			}
		}
		return tx.seedSprints(admin.Person, statuses)
	})
}

// seedSprints mirrors the sprint fixture shared with the SPA mock. Historical
// ledger entries are intentionally inserted at their event instants, not now.
func (t *Tx) seedSprints(actor domain.Person, statuses []domain.Status) error {
	var completed string
	for _, status := range statuses {
		if status.Category == "completed" {
			completed = status.ID
		}
	}
	for _, input := range []IssueCreate{
		{Title: "Speed up issue search", Type: "task"},
		{Title: "Add bulk status change", Type: "feature"},
		{Title: "Tidy up the settings layout", Type: "task"},
		{Title: "Show issue counts per project", Type: "feature"},
	} {
		input.Priority = "medium"
		input.StatusID = completed
		if _, err := t.CreateIssue(input, actor, nil); err != nil {
			return err
		}
	}
	// Match the original mock's issue timestamps without moving issue numbers.
	if err := t.Exec(`UPDATE tracker_issue SET created_at='2026-10-20T00:00:00Z'::timestamptz+number*interval '1 hour', updated_at='2026-10-20T00:00:00Z'::timestamptz+number*interval '1 hour', completed_at=CASE WHEN completed_at IS NOT NULL THEN '2026-10-20T00:00:00Z'::timestamptz+number*interval '1 hour' END WHERE workspace_id=$1`, t.WorkspaceID); err != nil {
		return err
	}
	sizes := map[int]string{8: "XS", 16: "XS", 3: "S", 10: "S", 30: "S", 2: "M", 4: "M", 14: "M", 11: "L", 17: "L", 37: "L", 5: "XL", 23: "XL", 29: "XL", 38: "XL", 39: "XL", 40: "XL"}
	for number, size := range sizes {
		if err := t.Exec(`UPDATE tracker_issue SET estimate=$3 WHERE workspace_id=$1 AND number=$2`, t.WorkspaceID, number, size); err != nil {
			return err
		}
	}
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return err
	}
	now := t.now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	at := func(offset, hour int) time.Time {
		return today.AddDate(0, 0, offset).Add(time.Duration(hour) * time.Hour).UTC()
	}
	fixtures := []struct {
		start, weeks int
		goal         string
		members      []int
	}{
		{-24, 1, "Bug intake basics", []int{5, 11, 17}},
		{-17, 1, "Triage flow", []int{23, 29, 37}},
		{-10, 1, "Board polish", []int{38, 39, 40}},
		{-3, 2, "Sprint planning and burndown", []int{2, 3, 4, 10, 15, 30, 34}},
		{11, 1, "", []int{8, 14, 26}},
	}
	ids := make([]string, len(fixtures))
	for i, f := range fixtures {
		id := ulid.Make().String()
		ids[i] = id
		start := today.AddDate(0, 0, f.start)
		end := start.AddDate(0, 0, 7*f.weeks-1)
		created := at(f.start-1, 15)
		updated := created
		var started, closed *time.Time
		if i < 4 {
			v := at(f.start, 9)
			started = &v
			updated = v
		}
		if i < 3 {
			v := at(f.start+6, 18)
			closed = &v
			updated = v
		}
		if i == 4 {
			created = at(-1, 10)
			updated = created
		}
		if err := t.Exec(`INSERT INTO tracker_sprint (id,workspace_id,number,name,goal,length_weeks,starts_on,ends_on,started_at,closed_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, t.WorkspaceID, i+1, fmt.Sprintf("Sprint %d", i+1), f.goal, f.weeks, start.Format("2006-01-02"), end.Format("2006-01-02"), started, closed, created, updated); err != nil {
			return err
		}
		for _, number := range f.members {
			if err := t.Exec(`UPDATE tracker_issue SET sprint_id=$3 WHERE workspace_id=$1 AND number=$2`, t.WorkspaceID, number, id); err != nil {
				return err
			}
		}
	}
	rows := []struct {
		sprint    int
		kind      string
		numbers   []int
		day, hour int
	}{
		{1, "join", []int{5, 11, 17, 2}, -25, 15},
		{1, "done", []int{5}, -22, 16}, {1, "done", []int{11}, -20, 11}, {1, "done", []int{17}, -18, 17},
		{2, "join", []int{23, 29, 37}, -18, 15}, {2, "join", []int{2}, -18, 18},
		{2, "done", []int{23}, -16, 16}, {2, "done", []int{37}, -14, 11}, {2, "done", []int{29}, -12, 17},
		{3, "join", []int{38, 39, 40}, -11, 15}, {3, "join", []int{2}, -11, 18},
		{3, "done", []int{38}, -9, 16}, {3, "done", []int{39}, -7, 11}, {3, "done", []int{40}, -4, 10},
		{4, "join", []int{3, 4, 15, 30, 34}, -4, 14}, {4, "join", []int{2}, -4, 18},
		{4, "join", []int{10}, -2, 11}, {4, "cancel", []int{30}, -1, 15},
		{5, "join", []int{8, 14, 26}, -1, 10},
	}
	for _, row := range rows {
		for _, number := range row.numbers {
			after := domain.SprintStanding{SprintID: ids[row.sprint-1], Size: sizes[number], Category: "started"}
			before := domain.SprintStanding{}
			if row.kind != "join" {
				before = after
				if row.kind == "done" {
					after.Category = "completed"
				} else {
					after.Category = "canceled"
				}
			}
			for sprint, d := range domain.SprintDeltas(before, after) {
				if err := t.Exec(`INSERT INTO tracker_sprint_event (id,sprint_id,issue_id,at,scope_points,scope_issues,done_points,done_issues) SELECT $1,$2,id,$4,$5,$6,$7,$8 FROM tracker_issue WHERE workspace_id=$9 AND number=$3`, ulid.Make().String(), sprint, number, at(row.day, row.hour), d.ScopePoints, d.ScopeIssues, d.DonePoints, d.DoneIssues, t.WorkspaceID); err != nil {
					return err
				}
			}
		}
	}
	return t.Exec(`UPDATE tracker_workspace SET sprint_seq=5 WHERE id=$1`, t.WorkspaceID)
}
