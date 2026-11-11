package store

import (
	"fmt"
	"testing"

	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestHierarchyDerivationAndProgress(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "hierarchy"))
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, database.InWorkspace(t.Context(), "hierarchy", true, func(tx *Tx) error {
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		create := func(kind, parent, status string) domain.Issue {
			t.Helper()
			input := IssueCreate{Title: kind, Type: kind, StatusID: status}
			if parent != "" {
				input.ParentID = &parent
			}
			item, err := tx.CreateIssue(input, actor.Person, nil)
			require.NoError(t, err)
			return item
		}
		epic := create("epic", "", statuses[2].ID)
		story := create("story", epic.ID, statuses[2].ID)
		task := create("task", story.ID, "")
		subtask := create("task", task.ID, statuses[4].ID)
		canceled := create("feature", story.ID, statuses[5].ID)
		deleted := create("task", story.ID, statuses[4].ID)
		require.NoError(t, tx.DeleteIssue(deleted.ID, actor))
		standalone := create("task", "", "")
		for _, tc := range []struct {
			issue    domain.Issue
			epic     *domain.IssueRef
			story    *domain.IssueRef
			progress *domain.Progress
		}{
			{epic, nil, nil, &domain.Progress{Total: 2, Completed: 1}},
			{story, ptrRef(epic), nil, &domain.Progress{Total: 2, Completed: 1}},
			{task, ptrRef(epic), ptrRef(story), nil},
			{subtask, ptrRef(epic), ptrRef(story), nil},
			{canceled, ptrRef(epic), ptrRef(story), nil},
			{standalone, nil, nil, nil},
		} {
			item, err := tx.Issue(tc.issue.ID)
			require.NoError(t, err)
			require.Equal(t, tc.epic, item.Epic)
			require.Equal(t, tc.story, item.Story)
			require.Equal(t, tc.progress, item.Progress)
			require.Equal(t, tc.issue.StatusID, item.StatusID, "progress must not derive status")
			page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Q: item.Title}})
			require.NoError(t, err)
			found := false
			for _, row := range page.Items {
				if row.ID == item.ID {
					require.Equal(t, item.IssueSummary, row)
					found = true
				}
			}
			require.True(t, found)
		}
		for _, tc := range []struct {
			name   string
			filter domain.Filter
			ids    []string
		}{
			{"epic id", domain.Filter{Epic: []string{epic.ID}}, []string{story.ID, task.ID, subtask.ID, canceled.ID}},
			{"no epic", domain.Filter{Epic: []string{"none"}}, []string{epic.ID, standalone.ID}},
			{"epic and none", domain.Filter{Epic: []string{epic.ID, "none"}}, []string{epic.ID, story.ID, task.ID, subtask.ID, canceled.ID, standalone.ID}},
			{"story id", domain.Filter{Story: []string{story.ID}}, []string{task.ID, subtask.ID, canceled.ID}},
			{"no story", domain.Filter{Story: []string{"none"}}, []string{epic.ID, story.ID, standalone.ID}},
			{"story and none", domain.Filter{Story: []string{story.ID, "none"}}, []string{epic.ID, story.ID, task.ID, subtask.ID, canceled.ID, standalone.ID}},
			{"combined", domain.Filter{Epic: []string{epic.ID}, Story: []string{"none"}}, []string{story.ID}},
			{"wrong type id", domain.Filter{Epic: []string{task.ID}}, nil},
		} {
			t.Run(tc.name, func(t *testing.T) {
				page, err := tx.ListIssues(ListOptions{Filter: tc.filter})
				require.NoError(t, err)
				ids := make([]string, 0, len(page.Items))
				for _, row := range page.Items {
					ids = append(ids, row.ID)
				}
				require.ElementsMatch(t, tc.ids, ids)
			})
		}
		next := create("epic", "", "")
		_, err = tx.PatchIssue(story.ID, IssuePatch{ParentID: field(next.ID)}, actor.Person, nil)
		require.NoError(t, err)
		item, err := tx.Issue(subtask.ID)
		require.NoError(t, err)
		require.Equal(t, next.ID, item.Epic.ID)
		require.Equal(t, story.ID, item.Story.ID)
		for id, progress := range map[string]domain.Progress{epic.ID: {}, next.ID: {Total: 2, Completed: 1}} {
			item, err := tx.Issue(id)
			require.NoError(t, err)
			require.Equal(t, &progress, item.Progress)
		}
		_, err = tx.PatchIssue(subtask.ID, IssuePatch{StatusID: field(statuses[5].ID)}, actor.Person, nil)
		require.NoError(t, err)
		item, err = tx.Issue(story.ID)
		require.NoError(t, err)
		require.Equal(t, &domain.Progress{Total: 1}, item.Progress)
		return nil
	}))
}

func ptrRef(issue domain.Issue) *domain.IssueRef {
	value := ref(issue)
	return &value
}

func TestHierarchyValidation(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "hierarchy"))
	actor := domain.Person{Sub: "alex", Name: "Alex"}
	require.NoError(t, database.InWorkspace(t.Context(), "hierarchy", true, func(tx *Tx) error {
		epic, err := tx.CreateIssue(IssueCreate{Title: "Epic", Type: "epic"}, actor, nil)
		require.NoError(t, err)
		story, err := tx.CreateIssue(IssueCreate{Title: "Story", Type: "story", ParentID: &epic.ID}, actor, nil)
		require.NoError(t, err)
		task, err := tx.CreateIssue(IssueCreate{Title: "Task", Type: "task", ParentID: &story.ID}, actor, nil)
		require.NoError(t, err)
		for _, tc := range []struct {
			kind, parent, message string
		}{
			{"epic", epic.ID, "Epics cannot have a parent"},
			{"epic", story.ID, "Epics cannot have a parent"},
			{"epic", task.ID, "Epics cannot have a parent"},
			{"story", story.ID, "Stories can only have an epic parent"},
			{"story", task.ID, "Stories can only have an epic parent"},
		} {
			t.Run("create "+tc.kind+" under "+tc.parent, func(t *testing.T) {
				_, err := tx.CreateIssue(IssueCreate{Title: "Invalid", Type: tc.kind, ParentID: &tc.parent}, actor, nil)
				var invalid *domain.FieldError
				require.ErrorAs(t, err, &invalid)
				require.Equal(t, &domain.FieldError{Path: "parentId", Message: tc.message}, invalid)
			})
		}
		for _, tc := range []struct {
			name, id, path string
			patch          IssuePatch
		}{
			{"epic with stories to story", epic.ID, "type", IssuePatch{Type: field("story")}},
			{"epic with stories to task", epic.ID, "type", IssuePatch{Type: field("task")}},
			{"task under story to epic", task.ID, "type", IssuePatch{Type: field("epic")}},
			{"unchanged parent still type error", task.ID, "type", IssuePatch{Type: field("epic"), ParentID: field(story.ID)}},
			{"new parent error", task.ID, "parentId", IssuePatch{Type: field("epic"), ParentID: field(epic.ID)}},
			{"story under task", story.ID, "parentId", IssuePatch{ParentID: field(task.ID)}},
			{"epic with parent", epic.ID, "parentId", IssuePatch{ParentID: field(task.ID)}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, err := tx.PatchIssue(tc.id, tc.patch, actor, nil)
				var invalid *domain.FieldError
				require.ErrorAs(t, err, &invalid)
				require.Equal(t, tc.path, invalid.Path)
			})
		}
		item, err := tx.PatchIssue(task.ID, IssuePatch{Type: field("epic"), ParentID: Field[string]{Present: true}}, actor, nil)
		require.NoError(t, err)
		require.Nil(t, item.Parent)
		require.Equal(t, &domain.Progress{}, item.Progress)
		item, err = tx.PatchIssue(story.ID, IssuePatch{ParentID: Field[string]{Present: true}}, actor, nil)
		require.NoError(t, err)
		require.Nil(t, item.Epic)
		_, err = tx.PatchIssue(epic.ID, IssuePatch{Type: field("story")}, actor, nil)
		require.NoError(t, err)
		return nil
	}))
}

func TestHierarchyAncestorBound(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "depth"))
	actor := domain.Person{Sub: "alex", Name: "Alex"}
	require.NoError(t, database.InWorkspace(t.Context(), "depth", true, func(tx *Tx) error {
		epic, err := tx.CreateIssue(IssueCreate{Title: "Epic", Type: "epic"}, actor, nil)
		require.NoError(t, err)
		story, err := tx.CreateIssue(IssueCreate{Title: "Story", Type: "story", ParentID: &epic.ID}, actor, nil)
		require.NoError(t, err)
		parent := story.ID
		for depth := 1; depth <= 33; depth++ {
			item, err := tx.CreateIssue(IssueCreate{Title: fmt.Sprintf("Depth %d", depth), Type: "task", ParentID: &parent}, actor, nil)
			require.NoError(t, err)
			require.Equal(t, depth <= 31, item.Epic != nil)
			require.Equal(t, depth <= 32, item.Story != nil)
			parent = item.ID
		}
		for _, id := range []string{epic.ID, story.ID} {
			item, err := tx.Issue(id)
			require.NoError(t, err)
			require.Equal(t, &domain.Progress{Total: 33}, item.Progress)
		}
		page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Epic: []string{epic.ID}}})
		require.NoError(t, err)
		require.Len(t, page.Items, 32)
		page, err = tx.ListIssues(ListOptions{Filter: domain.Filter{Story: []string{story.ID}}})
		require.NoError(t, err)
		require.Len(t, page.Items, 32)
		return nil
	}))
}

func TestViewGroupingRoundTrip(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "views"))
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, database.InWorkspace(t.Context(), "views", true, func(tx *Tx) error {
		view, err := tx.CreateView(ViewCreate{Name: "Default"}, actor)
		require.NoError(t, err)
		require.Equal(t, "none", view.GroupBy)
		for _, group := range []string{"epic", "story", "none"} {
			input := ViewCreate{Name: group, GroupBy: &group, Filter: domain.Filter{Epic: []string{"none"}, Story: []string{"none"}}}
			created, err := tx.CreateView(input, actor)
			require.NoError(t, err)
			require.Equal(t, group, created.GroupBy)
			updated, err := tx.PatchView(view.ID, ViewPatch{GroupBy: &group}, actor)
			require.NoError(t, err)
			require.Equal(t, group, updated.GroupBy)
			views, err := tx.Views(actor.Sub)
			require.NoError(t, err)
			require.Contains(t, views, created)
			require.Contains(t, views, updated)
		}
		for _, group := range []string{"", "status"} {
			_, err := tx.CreateView(ViewCreate{Name: "Invalid", GroupBy: &group}, actor)
			require.Error(t, err)
			_, err = tx.PatchView(view.ID, ViewPatch{GroupBy: &group}, actor)
			require.Error(t, err)
		}
		return nil
	}))
}

func TestHierarchySeed(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.SeedDev(t.Context(), "seed"))
	require.NoError(t, database.SeedDev(t.Context(), "seed"))
	require.NoError(t, database.InWorkspace(t.Context(), "seed", false, func(tx *Tx) error {
		page, err := tx.ListIssues(ListOptions{Sort: domain.SortNumber})
		require.NoError(t, err)
		require.Len(t, page.Items, 42)
		epics, stories := page.Items[30:32], page.Items[32:36]
		require.Equal(t, "Reliable bug intake", epics[0].Title)
		require.Equal(t, "Faster triage", epics[1].Title)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		for _, item := range page.Items[30:36] {
			require.Equal(t, statuses[2].ID, item.StatusID)
			require.Nil(t, item.Report)
			require.NotNil(t, item.Progress)
		}
		for i, item := range stories {
			require.Equal(t, "story", item.Type)
			require.Equal(t, epics[i/2].ID, item.Epic.ID)
			require.Nil(t, item.Story)
		}
		for _, item := range page.Items[:30] {
			if item.Number%5 == 0 {
				require.Nil(t, item.Parent)
			} else {
				require.Equal(t, stories[item.Number%4].ID, item.Parent.ID)
				require.Equal(t, item.Parent, item.Story)
			}
		}
		views, err := tx.Views("dev-alex")
		require.NoError(t, err)
		require.Len(t, views, 3)
		require.Equal(t, "By epic", views[2].Name)
		require.Equal(t, "epic", views[2].GroupBy)
		require.Equal(t, "board", views[2].Layout)
		require.Equal(t, domain.Filter{}, views[2].Filter)
		require.True(t, views[2].Shared)
		return nil
	}))
}

func TestHierarchyStopsAtDeletedNodes(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "deleted"))
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, database.InWorkspace(t.Context(), "deleted", true, func(tx *Tx) error {
		epic, err := tx.CreateIssue(IssueCreate{Title: "Epic", Type: "epic"}, actor.Person, nil)
		require.NoError(t, err)
		story, err := tx.CreateIssue(IssueCreate{Title: "Story", Type: "story", ParentID: &epic.ID}, actor.Person, nil)
		require.NoError(t, err)
		task, err := tx.CreateIssue(IssueCreate{Title: "Task", Type: "task", ParentID: &story.ID}, actor.Person, nil)
		require.NoError(t, err)
		subtask, err := tx.CreateIssue(IssueCreate{Title: "Subtask", Type: "task", ParentID: &task.ID}, actor.Person, nil)
		require.NoError(t, err)
		require.NoError(t, tx.DeleteIssue(story.ID, actor))
		page, err := tx.ListIssues(ListOptions{Sort: domain.SortNumber})
		require.NoError(t, err)
		require.Len(t, page.Items, 3)
		for _, row := range page.Items {
			item, err := tx.Issue(row.ID)
			require.NoError(t, err)
			require.Equal(t, item.IssueSummary, row)
			require.Nil(t, row.Epic)
			require.Nil(t, row.Story)
			switch row.ID {
			case epic.ID:
				require.Equal(t, &domain.Progress{}, row.Progress)
			case task.ID:
				require.Nil(t, row.Parent)
			case subtask.ID:
				require.Equal(t, task.ID, row.Parent.ID)
			}
		}
		return nil
	}))
}
