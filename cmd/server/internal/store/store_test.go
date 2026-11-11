package store

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

func TestTranslate(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{{sql.ErrNoRows, 404}, {&pq.Error{Code: "23505"}, 409}, {&pq.Error{Code: "23503"}, 400}, {&pq.Error{Code: "23514"}, 400}} {
		var result *httpx.Error
		require.True(t, errors.As(translate(tc.err), &result))
		require.Equal(t, tc.status, result.Status)
		if tc.status == 400 {
			require.Equal(t, "invalid", result.Code)
		}
	}
	original := errors.New("other")
	require.ErrorIs(t, translate(original), original)
}
func field[T any](value T) Field[T] { return Field[T]{Present: true, Value: &value} }
func TestSeedPagingAndFilters(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.SeedDev(t.Context(), "pj-test"))
	require.NoError(t, database.SeedDev(t.Context(), "pj-test"))
	require.NoError(t, database.InWorkspace(t.Context(), "pj-test", true, func(tx *Tx) error {
		w, err := tx.Workspace()
		require.NoError(t, err)
		require.Equal(t, 42, w.IssueCount)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		require.Len(t, statuses, 6)
		labels, err := tx.Labels()
		require.NoError(t, err)
		require.Len(t, labels, 3)
		views, err := tx.Views("dev-alex")
		require.NoError(t, err)
		require.Len(t, views, 3)
		require.NoError(t, tx.Exec(`UPDATE tracker_issue SET created_at='2026-01-01T00:00:00Z',updated_at='2026-01-01T00:00:00Z'`))
		for _, order := range []domain.Sort{domain.SortUpdated, domain.SortCreated, domain.SortNumber, domain.SortPriority, domain.SortEstimate} {
			seen := map[string]bool{}
			cursor := ""
			for {
				page, err := tx.ListIssues(ListOptions{Limit: 5, Sort: order, Cursor: cursor})
				require.NoError(t, err)
				require.NotEmpty(t, page.Items)
				require.LessOrEqual(t, len(page.Items), 5)
				for _, item := range page.Items {
					require.False(t, seen[item.ID])
					seen[item.ID] = true
				}
				if page.NextCursor == nil {
					break
				}
				cursor = *page.NextCursor
			}
			require.Len(t, seen, 42)
		}
		for _, filter := range []domain.Filter{{Type: []string{"bug"}}, {Assignee: []string{"me"}}, {Category: []string{"started"}}, {Q: "Dashboard"}, {Environment: []string{"local"}}, {Surface: []string{"apth"}}, {Label: []string{labels[0].ID}}, {Status: []string{statuses[0].ID}}, {Priority: []string{"urgent"}}, {CreatedAfter: "2025-01-01T00:00:00Z"}, {Parent: "none"}} {
			page, err := tx.ListIssues(ListOptions{Filter: filter, Subject: "dev-alex"})
			require.NoError(t, err)
			require.NotEmpty(t, page.Items)
		}
		_, err = tx.ListIssues(ListOptions{Cursor: "bad"})
		require.Error(t, err)
		return nil
	}))
}
func TestMutationsAndIsolation(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "pj-one"))
	require.NoError(t, database.EnsureWorkspace(t.Context(), "pj-two"))
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	var id, statusID string
	require.NoError(t, database.InWorkspace(t.Context(), "pj-one", true, func(tx *Tx) error {
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		statusID = statuses[0].ID
		item, err := tx.CreateIssue(IssueCreate{Title: "A bug", Type: "bug", Report: &domain.Report{Environment: "local", Surface: "apth"}}, actor.Person, nil)
		require.NoError(t, err)
		id = item.ID
		found, err := tx.Issue("apt-1")
		require.NoError(t, err)
		require.Equal(t, id, found.ID)
		label, err := tx.CreateLabel("regression", "red")
		require.NoError(t, err)
		child, err := tx.CreateIssue(IssueCreate{Title: "Child", Type: "task", ParentID: &id}, actor.Person, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(id, IssuePatch{ParentID: field(child.ID)}, actor.Person, nil)
		require.ErrorContains(t, err, "cycle")
		item, err = tx.PatchIssue(id, IssuePatch{StatusID: field(statuses[4].ID), LabelIDs: field([]string{label.ID, label.ID}), Blocks: field([]string{child.ID}), Title: field("Updated")}, actor.Person, nil)
		require.NoError(t, err)
		require.NotNil(t, item.CompletedAt)
		require.Len(t, item.LabelIDs, 1)
		require.Len(t, item.Blocks, 1)
		timeline, err := tx.Timeline(id)
		require.NoError(t, err)
		require.Len(t, timeline, 5)
		_, err = tx.PatchIssue(id, IssuePatch{Title: field("Updated")}, actor.Person, nil)
		require.NoError(t, err)
		timeline, err = tx.Timeline(id)
		require.NoError(t, err)
		require.Len(t, timeline, 5)
		item, err = tx.PatchIssue(id, IssuePatch{Type: field("task"), StatusID: field(statuses[1].ID)}, actor.Person, nil)
		require.NoError(t, err)
		require.Nil(t, item.Report)
		require.Nil(t, item.CompletedAt)
		_, err = tx.PatchIssue(id, IssuePatch{Type: field("bug")}, actor.Person, nil)
		require.Error(t, err)
		comment, err := tx.CreateComment(id, "Comment", actor.Person)
		require.NoError(t, err)
		_, err = tx.PatchComment(comment.ID, "Edited", domain.Actor{Person: domain.Person{Sub: "other"}, Role: "Admin"})
		require.Error(t, err)
		comment, err = tx.PatchComment(comment.ID, "Edited", actor)
		require.NoError(t, err)
		require.NotNil(t, comment.EditedAt)
		for range 10 {
			_, err = tx.CreateAttachment(id, "note.txt", "text/plain", []byte("Hello"), actor.Person)
			require.NoError(t, err)
		}
		_, err = tx.CreateAttachment(id, "excess.txt", "text/plain", []byte("Hello"), actor.Person)
		require.Error(t, err)
		require.Error(t, tx.DeleteStatus(statuses[1].ID))
		require.Error(t, tx.DeleteStatus(statuses[5].ID))
		key := "NEW"
		_, err = tx.PatchWorkspace(&key, nil, nil, nil, nil)
		require.NoError(t, err)
		item, err = tx.Issue("new-1")
		require.NoError(t, err)
		require.Equal(t, id, item.ID)
		return nil
	}))
	require.NoError(t, database.InWorkspace(t.Context(), "pj-two", false, func(tx *Tx) error {
		_, err := tx.Issue(id)
		require.ErrorIs(t, err, sql.ErrNoRows)
		_, err = tx.Status(statusID)
		require.ErrorIs(t, err, sql.ErrNoRows)
		return nil
	}))
	require.NoError(t, database.InWorkspace(t.Context(), "pj-one", true, func(tx *Tx) error {
		require.NoError(t, tx.DeleteIssue(id, actor))
		_, err := tx.Issue(id)
		require.ErrorIs(t, err, sql.ErrNoRows)
		return nil
	}))
}

func TestAssigneeMetadataDoesNotCreatePhantomActivity(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.EnsureWorkspace(t.Context(), "pj-test"))
	require.NoError(t, database.InWorkspace(t.Context(), "pj-test", true, func(tx *Tx) error {
		person := domain.Person{Sub: "alex", Name: "Alex", Email: "alex@example.test"}
		item, err := tx.CreateIssue(IssueCreate{Title: "Assigned", Type: "task"}, person, &person)
		require.NoError(t, err)
		_, err = tx.PatchIssue(item.ID, IssuePatch{AssigneeSub: field(person.Sub)}, person, &person)
		require.NoError(t, err)
		timeline, err := tx.Timeline(item.ID)
		require.NoError(t, err)
		require.Len(t, timeline, 1)
		return nil
	}))
}
