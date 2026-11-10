package store

import (
	"context"
	"fmt"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
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
		return nil
	})
}
