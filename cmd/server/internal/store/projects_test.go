package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
	"github.com/stretchr/testify/require"
)

func TestProjectsAndAssignments(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "one"))
	require.NoError(t, database.EnsureWorkspace(t.Context(), "two"))
	admin := domain.Actor{Person: domain.Person{Sub: "admin", Name: "Admin"}, Role: "Admin"}
	viewer := domain.Actor{Person: domain.Person{Sub: "viewer", Name: "Viewer"}, Role: "Viewer"}
	var project, other domain.Project
	var assigned, unassigned domain.Issue
	require.NoError(t, database.InWorkspace(t.Context(), "one", true, func(tx *Tx) error {
		list, err := tx.Projects(false)
		require.NoError(t, err)
		require.NotNil(t, list)
		require.Empty(t, list)
		project, err = tx.CreateProject(ProjectCreate{Name: " Dashboard "}, viewer)
		require.NoError(t, err)
		require.Equal(t, "Dashboard", project.Name)
		require.Equal(t, "gray", project.Color)
		require.False(t, project.Archived)
		require.Zero(t, project.IssueCount)
		require.Zero(t, project.OpenIssueCount)
		require.False(t, project.CreatedAt.IsZero())
		other, err = tx.CreateProject(ProjectCreate{Name: "API"}, admin)
		require.NoError(t, err)
		assigned, err = tx.CreateIssue(IssueCreate{Title: "Assigned", Type: "task", ProjectID: &project.ID}, viewer.Person, nil)
		require.NoError(t, err)
		require.Equal(t, &project.ID, assigned.ProjectID)
		unassigned, err = tx.CreateIssue(IssueCreate{Title: "Unassigned", Type: "task"}, viewer.Person, nil)
		require.NoError(t, err)
		require.Nil(t, unassigned.ProjectID)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		for _, status := range statuses {
			if status.Category == "completed" || status.Category == "canceled" {
				_, err := tx.CreateIssue(IssueCreate{Title: status.Name, Type: "task", StatusID: status.ID, ProjectID: &project.ID}, viewer.Person, nil)
				require.NoError(t, err)
			}
		}
		list, err = tx.Projects(false)
		require.NoError(t, err)
		require.Equal(t, []string{"API", "Dashboard"}, []string{list[0].Name, list[1].Name})
		require.Equal(t, 3, list[1].IssueCount)
		require.Equal(t, 1, list[1].OpenIssueCount)
		for _, tc := range []struct {
			ids   []string
			count int
		}{
			{[]string{project.ID}, 3}, {[]string{"none"}, 1}, {[]string{project.ID, "none"}, 4}, {[]string{other.ID}, 0},
		} {
			page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Project: tc.ids}})
			require.NoError(t, err)
			require.Len(t, page.Items, tc.count)
		}
		archived := true
		_, err = tx.PatchProject(project.ID, ProjectPatch{Archived: &archived}, viewer)
		require.Error(t, err)
		project, err = tx.PatchProject(project.ID, ProjectPatch{Archived: &archived}, admin)
		require.NoError(t, err)
		require.True(t, project.Archived)
		list, err = tx.Projects(false)
		require.NoError(t, err)
		require.Len(t, list, 1)
		list, err = tx.Projects(true)
		require.NoError(t, err)
		require.Len(t, list, 2)
		_, err = tx.PatchIssue(assigned.ID, IssuePatch{Title: field("Still assigned")}, viewer.Person, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(assigned.ID, IssuePatch{ProjectID: field(project.ID)}, viewer.Person, nil)
		require.NoError(t, err)
		for _, id := range []string{project.ID, ulid.Make().String(), "bad", ""} {
			_, err := tx.CreateIssue(IssueCreate{Title: "Invalid", Type: "task", ProjectID: &id}, viewer.Person, nil)
			var fieldError *domain.FieldError
			require.ErrorAs(t, err, &fieldError)
			require.Equal(t, "projectId", fieldError.Path)
			_, err = tx.PatchIssue(unassigned.ID, IssuePatch{ProjectID: field(id)}, viewer.Person, nil)
			require.ErrorAs(t, err, &fieldError)
		}
		var conflict *httpx.Error
		require.ErrorAs(t, tx.DeleteProject(project.ID, admin), &conflict)
		require.Equal(t, 409, conflict.Status)
		_, err = tx.PatchIssue(assigned.ID, IssuePatch{ProjectID: field(other.ID)}, viewer.Person, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(assigned.ID, IssuePatch{ProjectID: Field[string]{Present: true}}, viewer.Person, nil)
		require.NoError(t, err)
		timeline, err := tx.Timeline(assigned.ID)
		require.NoError(t, err)
		var changes []domain.Activity
		for _, entry := range timeline {
			if entry.Activity != nil && entry.Activity.Field == "project" {
				changes = append(changes, *entry.Activity)
			}
		}
		require.Len(t, changes, 2)
		require.Equal(t, project.ID, changes[0].From)
		require.Equal(t, other.ID, changes[0].To)
		require.Equal(t, other.ID, changes[1].From)
		require.Nil(t, changes[1].To)
		return nil
	}))
	// Constraint failures roll back their transaction; subsequent operations use a fresh one.
	for _, patch := range []bool{false, true} {
		err := database.InWorkspace(t.Context(), "one", true, func(tx *Tx) error {
			if patch {
				_, err := tx.PatchProject(other.ID, ProjectPatch{Name: &project.Name}, viewer)
				return err
			}
			_, err := tx.CreateProject(ProjectCreate{Name: project.Name}, viewer)
			return err
		})
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, "conflict", conflict.Code)
	}
	require.NoError(t, database.InWorkspace(t.Context(), "two", true, func(tx *Tx) error {
		_, err := tx.Project(project.ID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		_, err = tx.PatchProject(project.ID, ProjectPatch{}, admin)
		require.ErrorIs(t, err, sql.ErrNoRows)
		require.ErrorIs(t, tx.DeleteProject(project.ID, admin), sql.ErrNoRows)
		_, err = tx.CreateIssue(IssueCreate{Title: "Cross workspace", Type: "task", ProjectID: &other.ID}, viewer.Person, nil)
		var invalid *domain.FieldError
		require.ErrorAs(t, err, &invalid)
		_, err = tx.CreateProject(ProjectCreate{Name: project.Name}, viewer)
		require.NoError(t, err)
		return nil
	}))
	require.NoError(t, database.InWorkspace(t.Context(), "one", true, func(tx *Tx) error {
		page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Project: []string{project.ID}}})
		require.NoError(t, err)
		for _, issue := range page.Items {
			require.NoError(t, tx.DeleteIssue(issue.ID, admin))
		}
		item, err := tx.Project(project.ID)
		require.NoError(t, err)
		require.Zero(t, item.IssueCount)
		require.Zero(t, item.OpenIssueCount)
		require.NoError(t, tx.DeleteProject(project.ID, admin))
		_, err = tx.Project(project.ID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		var references int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM tracker_issue WHERE project_id=$1`, project.ID).Scan(&references))
		require.Zero(t, references)
		return nil
	}))
}

func TestProjectSeedAssignment(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.SeedDev(t.Context(), "seed"))
	require.NoError(t, database.SeedDev(t.Context(), "seed"))
	require.NoError(t, database.InWorkspace(t.Context(), "seed", false, func(tx *Tx) error {
		projects, err := tx.Projects(true)
		require.NoError(t, err)
		require.Len(t, projects, 3)
		byName := map[string]domain.Project{}
		for _, project := range projects {
			byName[project.Name] = project
		}
		for name, color := range map[string]string{"Dashboard": "blue", "Platform API": "purple", "Builder Console": "orange"} {
			require.Equal(t, color, byName[name].Color)
		}
		page, err := tx.ListIssues(ListOptions{Sort: domain.SortNumber})
		require.NoError(t, err)
		require.Len(t, page.Items, 42)
		names := []string{"Dashboard", "Platform API", "Builder Console"}
		for _, issue := range page.Items {
			n := issue.Number
			if n > 40 {
				require.Equal(t, byName["Platform API"].ID, *issue.ProjectID)
				continue
			}
			if n > 30 || n%3 == 0 {
				require.Nil(t, issue.ProjectID)
			} else {
				require.NotNil(t, issue.ProjectID)
				require.Equal(t, byName[names[(n%3+n%2)%3]].ID, *issue.ProjectID)
			}
		}
		return nil
	}))
}

func TestProjectsMigrationFromV010(t *testing.T) {
	legacy := fstest.MapFS{}
	paths, err := fs.Glob(migrations, "migrations/*.sql")
	require.NoError(t, err)
	for _, path := range paths {
		if path >= "migrations/008" {
			continue
		}
		source, err := migrations.ReadFile(path)
		require.NoError(t, err)
		legacy[path] = &fstest.MapFile{Data: source}
	}
	require.Len(t, legacy, 7)
	old, dsn := testutil.Database(t, func(ctx context.Context, dsn string) (*pgstore.Store, error) {
		return pgstore.Open(ctx, dsn, legacy, "tracker_schema_migrations")
	})
	issueID, statusID := ulid.Make().String(), ulid.Make().String()
	require.NoError(t, old.Do(t.Context(), true, func(tx *pgstore.Tx) error {
		if err := tx.Exec(`INSERT INTO tracker_workspace (id,key,name,issue_seq) VALUES ('legacy','APT','Existing workspace',1)`); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO tracker_status (id,workspace_id,name,category,position) VALUES ($1,'legacy','Todo','unstarted',0)`, statusID); err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO tracker_issue (id,workspace_id,number,title,type,status_id,reporter_sub,reporter_name) VALUES ($1,'legacy',1,'Existing issue','task',$2,'existing','Existing')`, issueID, statusID)
	}))
	database, err := Open(t.Context(), dsn)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	// Seeding an existing installation must not create projects or change real issues.
	require.NoError(t, database.SeedDev(t.Context(), "legacy"))
	require.NoError(t, database.InWorkspace(t.Context(), "legacy", false, func(tx *Tx) error {
		projects, err := tx.Projects(true)
		require.NoError(t, err)
		require.NotNil(t, projects)
		require.Empty(t, projects)
		issue, err := tx.Issue(issueID)
		require.NoError(t, err)
		require.Equal(t, "Existing issue", issue.Title)
		require.Nil(t, issue.ProjectID)
		page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Project: []string{"none"}}})
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
		for _, value := range []any{issue, page.Items[0]} {
			data, err := json.Marshal(value)
			require.NoError(t, err)
			var fields map[string]any
			require.NoError(t, json.Unmarshal(data, &fields))
			require.Contains(t, fields, "projectId")
			require.Nil(t, fields["projectId"])
		}
		var versions int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM tracker_schema_migrations`).Scan(&versions))
		require.Equal(t, 14, versions)
		var reporterIndex string
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='tracker_issue_reporter'`).Scan(&reporterIndex))
		require.Contains(t, reporterIndex, "USING btree (workspace_id, reporter_sub) WHERE (deleted_at IS NULL)")
		return nil
	}))
}
