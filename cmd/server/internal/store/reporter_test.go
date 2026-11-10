package store

import (
	"slices"
	"testing"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestReporterFilters(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "one"))
	require.NoError(t, database.EnsureWorkspace(t.Context(), "two"))
	alex := domain.Person{Sub: "alex", Name: "Alex"}
	other := domain.Person{Sub: "other", Name: "Other"}
	require.NoError(t, database.InWorkspace(t.Context(), "two", true, func(tx *Tx) error {
		_, err := tx.CreateIssue(IssueCreate{Title: "Another workspace", Type: "task"}, alex, nil)
		return err
	}))
	require.NoError(t, database.InWorkspace(t.Context(), "one", true, func(tx *Tx) error {
		project, err := tx.CreateProject(ProjectCreate{Name: "Dashboard"}, domain.Actor{Person: alex})
		require.NoError(t, err)
		create := func(title, kind string, projectID *string, reporter, assignee domain.Person) domain.Issue {
			t.Helper()
			input := IssueCreate{Title: title, Type: kind, ProjectID: projectID}
			if kind == "bug" {
				input.Report = &domain.Report{Environment: "local", Surface: "apth"}
			}
			item, err := tx.CreateIssue(input, reporter, &assignee)
			require.NoError(t, err)
			return item
		}
		bug := create("Alex project bug", "bug", &project.ID, alex, other)
		task := create("Alex project task", "task", &project.ID, alex, other)
		noProject := create("Alex no project bug", "bug", nil, alex, other)
		otherBug := create("Other project bug", "bug", &project.ID, other, alex)
		deleted := create("Deleted Alex bug", "bug", &project.ID, alex, other)
		require.NoError(t, tx.DeleteIssue(deleted.ID, domain.Actor{Person: alex, Role: "Admin"}))
		for _, tc := range []struct {
			name    string
			subject string
			filter  domain.Filter
			ids     []string
		}{
			{"omitted", "alex", domain.Filter{}, []string{bug.ID, task.ID, noProject.ID, otherBug.ID}},
			{"empty list", "alex", domain.Filter{Reporter: []string{}}, []string{bug.ID, task.ID, noProject.ID, otherBug.ID}},
			{"me", "alex", domain.Filter{Reporter: []string{"me"}}, []string{bug.ID, task.ID, noProject.ID}},
			{"me for other caller", "other", domain.Filter{Reporter: []string{"me"}}, []string{otherBug.ID}},
			{"explicit subject", "alex", domain.Filter{Reporter: []string{"other"}}, []string{otherBug.ID}},
			{"multiple subjects", "alex", domain.Filter{Reporter: []string{"me", "other"}}, []string{bug.ID, task.ID, noProject.ID, otherBug.ID}},
			{"unknown subject", "alex", domain.Filter{Reporter: []string{"missing"}}, []string{}},
			{"with project and type", "alex", domain.Filter{Reporter: []string{"me"}, Project: []string{project.ID}, Type: []string{"bug"}}, []string{bug.ID}},
			{"with no project", "alex", domain.Filter{Reporter: []string{"me"}, Project: []string{"none"}, Type: []string{"bug"}}, []string{noProject.ID}},
			{"independent assignee", "alex", domain.Filter{Reporter: []string{"other"}, Assignee: []string{"me"}}, []string{otherBug.ID}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				reporters := slices.Clone(tc.filter.Reporter)
				page, err := tx.ListIssues(ListOptions{Filter: tc.filter, Subject: tc.subject})
				require.NoError(t, err)
				ids := make([]string, 0, len(page.Items))
				for _, item := range page.Items {
					ids = append(ids, item.ID)
				}
				require.ElementsMatch(t, tc.ids, ids)
				require.Equal(t, reporters, tc.filter.Reporter, "me resolution must not mutate the filter")
			})
		}
		return nil
	}))
}
