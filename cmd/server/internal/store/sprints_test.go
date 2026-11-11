package store

import (
	"encoding/json"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func sprintClock(s string) time.Time {
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return v
}
func sprintInput(start string, weeks int) SprintCreate {
	return SprintCreate{StartsOn: &start, LengthWeeks: &weeks}
}
func assertLedgerRecount(t *testing.T, tx *Tx, id string) {
	t.Helper()
	var want domain.Tally
	rows, err := tx.SQL.QueryContext(tx.Context, `SELECT coalesce(i.estimate,''),s.category FROM tracker_issue i JOIN tracker_status s ON s.id=i.status_id WHERE i.workspace_id=$1 AND i.sprint_id=$2 AND i.deleted_at IS NULL`, tx.WorkspaceID, id)
	require.NoError(t, err)
	for rows.Next() {
		var size, category string
		require.NoError(t, rows.Scan(&size, &category))
		v := domain.Contribution(domain.SprintStanding{SprintID: id, Size: size, Category: category})
		want.ScopePoints += v.ScopePoints
		want.ScopeIssues += v.ScopeIssues
		want.DonePoints += v.DonePoints
		want.DoneIssues += v.DoneIssues
	}
	require.NoError(t, rows.Err())
	require.NoError(t, rows.Close())
	got, err := tx.sprintTally(id, nil, "")
	require.NoError(t, err)
	require.Equal(t, want, got)
}
func TestSprintLedgerInvariant(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "ledger"))
	now := sprintClock("2026-11-02T00:00:00Z")
	db.Now = func() time.Time { return now }
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, db.InWorkspace(t.Context(), "ledger", true, func(tx *Tx) error {
		a, err := tx.CreateSprint(sprintInput("2026-11-02", 1))
		require.NoError(t, err)
		b, err := tx.CreateSprint(sprintInput("2026-11-09", 2))
		require.NoError(t, err)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		items := []domain.Issue{}
		sizes := []string{"XS", "S", "M", "L", "XL"}
		for i := range 12 {
			size := sizes[i%5]
			sprint := a.ID
			if i%2 == 1 {
				sprint = b.ID
			}
			item, err := tx.CreateIssue(IssueCreate{Title: "Member", Type: "task", Estimate: &size, SprintID: &sprint}, actor.Person, nil)
			require.NoError(t, err)
			items = append(items, item)
			assertLedgerRecount(t, tx, a.ID)
			assertLedgerRecount(t, tx, b.ID)
		}
		rng := rand.New(rand.NewPCG(42, 7))
		for i := range 90 {
			now = now.Add(time.Minute)
			index := rng.IntN(len(items))
			item := items[index]
			patch := IssuePatch{}
			switch i % 4 {
			case 0:
				patch.StatusID = field(statuses[rng.IntN(len(statuses))].ID)
			case 1:
				if i%8 == 1 {
					patch.Estimate = Field[string]{Present: true}
				} else {
					patch.Estimate = field(sizes[rng.IntN(5)])
				}
			case 2:
				sprint := a.ID
				if i%8 == 2 {
					sprint = b.ID
				}
				patch.SprintID = field(sprint)
			case 3:
				patch.SprintID = Field[string]{Present: true}
			}
			item, err = tx.PatchIssue(item.ID, patch, actor.Person, nil)
			require.NoError(t, err)
			items[index] = item
			assertLedgerRecount(t, tx, a.ID)
			assertLedgerRecount(t, tx, b.ID)
		}
		for _, item := range items[:4] {
			require.NoError(t, tx.DeleteIssue(item.ID, actor))
			assertLedgerRecount(t, tx, a.ID)
			assertLedgerRecount(t, tx, b.ID)
		}
		return nil
	}))
}
func TestSprintLifecycleAndFrozenLedger(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "sprints"))
	now := sprintClock("2026-11-02T01:00:00Z")
	db.Now = func() time.Time { return now }
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, db.InWorkspace(t.Context(), "sprints", true, func(tx *Tx) error {
		a, err := tx.CreateSprint(sprintInput("2026-11-02", 1))
		require.NoError(t, err)
		b, err := tx.CreateSprint(sprintInput("2026-11-09", 1))
		require.NoError(t, err)
		c, err := tx.CreateSprint(sprintInput("2026-11-16", 2))
		require.NoError(t, err)
		size := "M"
		done, err := tx.CreateIssue(IssueCreate{Title: "Done", Type: "task", Estimate: &size, SprintID: &a.ID}, actor.Person, nil)
		require.NoError(t, err)
		open, err := tx.CreateIssue(IssueCreate{Title: "Open", Type: "task", Estimate: &size, SprintID: &a.ID}, actor.Person, nil)
		require.NoError(t, err)
		canceled, err := tx.CreateIssue(IssueCreate{Title: "Canceled", Type: "task", Estimate: &size, SprintID: &a.ID}, actor.Person, nil)
		require.NoError(t, err)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		var completedID, canceledID string
		for _, s := range statuses {
			if s.Category == "completed" {
				completedID = s.ID
			}
			if s.Category == "canceled" {
				canceledID = s.ID
			}
		}
		now = now.Add(time.Minute)
		a, err = tx.StartSprint(a.ID)
		require.NoError(t, err)
		require.Equal(t, 9, a.Commitment.ScopePoints)
		_, err = tx.StartSprint(b.ID)
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, 409, conflict.Status)
		now = now.Add(time.Hour)
		_, err = tx.PatchIssue(done.ID, IssuePatch{StatusID: field(completedID)}, actor.Person, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(canceled.ID, IssuePatch{StatusID: field(canceledID)}, actor.Person, nil)
		require.NoError(t, err)
		assertLedgerRecount(t, tx, a.ID)
		now = now.Add(time.Hour)
		closed, err := tx.CloseSprint(a.ID, &b.ID, actor.Person)
		require.NoError(t, err)
		require.Equal(t, domain.Tally{ScopePoints: 6, ScopeIssues: 2, DonePoints: 3, DoneIssues: 1}, closed.Current)
		require.Equal(t, 9, closed.Commitment.ScopePoints)
		got, err := tx.Issue(done.ID)
		require.NoError(t, err)
		require.Equal(t, a.ID, got.Sprint.ID)
		got, err = tx.Issue(canceled.ID)
		require.NoError(t, err)
		require.Equal(t, a.ID, got.Sprint.ID)
		got, err = tx.Issue(open.ID)
		require.NoError(t, err)
		require.Equal(t, b.ID, got.Sprint.ID)
		assertLedgerRecount(t, tx, b.ID)
		var events int
		require.NoError(t, tx.SQL.QueryRowContext(tx.Context, `SELECT count(*) FROM tracker_sprint_event WHERE sprint_id=$1`, a.ID).Scan(&events))
		now = now.Add(time.Hour)
		_, err = tx.PatchIssue(done.ID, IssuePatch{Estimate: field("XL"), StatusID: field(statuses[0].ID)}, actor.Person, nil)
		require.NoError(t, err)
		require.NoError(t, tx.DeleteIssue(done.ID, actor))
		var after int
		require.NoError(t, tx.SQL.QueryRowContext(tx.Context, `SELECT count(*) FROM tracker_sprint_event WHERE sprint_id=$1`, a.ID).Scan(&after))
		require.Equal(t, events, after)
		_, err = tx.PatchIssue(canceled.ID, IssuePatch{SprintID: Field[string]{Present: true}}, actor.Person, nil)
		var fieldErr *domain.FieldError
		require.ErrorAs(t, err, &fieldErr)
		require.Equal(t, "sprintId", fieldErr.Path)
		velocity, err := tx.Velocity("points", "", 8)
		require.NoError(t, err)
		require.Len(t, velocity.Items, 1)
		require.Equal(t, 3, velocity.Items[0].Completed)
		require.NoError(t, tx.DeleteSprint(b.ID, actor))
		got, err = tx.Issue(open.ID)
		require.NoError(t, err)
		require.Nil(t, got.Sprint)
		require.NoError(t, tx.DeleteSprint(c.ID, actor))
		next, err := tx.CreateSprint(sprintInput("2026-12-01", 1))
		require.NoError(t, err)
		require.Equal(t, int64(4), next.Number)
		return nil
	}))
}
func TestSprintLineageAndCarryOverConflict(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "lineage"))
	now := sprintClock("2026-11-02T01:00:00Z")
	db.Now = func() time.Time { return now }
	actor := domain.Person{Sub: "alex", Name: "Alex"}
	require.NoError(t, db.InWorkspace(t.Context(), "lineage", true, func(tx *Tx) error {
		a, err := tx.CreateSprint(sprintInput("2026-11-02", 1))
		require.NoError(t, err)
		b, err := tx.CreateSprint(sprintInput("2026-11-09", 1))
		require.NoError(t, err)
		epic, err := tx.CreateIssue(IssueCreate{Title: "Epic", Type: "epic"}, actor, nil)
		require.NoError(t, err)
		story, err := tx.CreateIssue(IssueCreate{Title: "Story", Type: "story", ParentID: &epic.ID, SprintID: &b.ID}, actor, nil)
		require.NoError(t, err)
		child, err := tx.CreateIssue(IssueCreate{Title: "Child", Type: "task", SprintID: &a.ID}, actor, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(child.ID, IssuePatch{ParentID: field(story.ID)}, actor, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(child.ID, IssuePatch{SprintID: field(b.ID)}, actor, nil)
		var fieldErr *domain.FieldError
		require.ErrorAs(t, err, &fieldErr)
		require.Equal(t, "sprintId", fieldErr.Path)
		_, err = tx.PatchIssue(story.ID, IssuePatch{SprintID: field(a.ID)}, actor, nil)
		require.Error(t, err)
		_, err = tx.PatchIssue(child.ID, IssuePatch{Type: field("epic"), ParentID: Field[string]{Present: true}}, actor, nil)
		require.Error(t, err)
		// A reparented intermediate node must check its descendants, not just itself.
		root, err := tx.CreateIssue(IssueCreate{Title: "Root", Type: "task"}, actor, nil)
		require.NoError(t, err)
		_, err = tx.CreateIssue(IssueCreate{Title: "Deep", Type: "task", ParentID: &root.ID, SprintID: &b.ID}, actor, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(root.ID, IssuePatch{ParentID: field(story.ID)}, actor, nil)
		require.ErrorAs(t, err, &fieldErr)
		require.Equal(t, "sprintId", fieldErr.Path)
		_, err = tx.StartSprint(a.ID)
		require.NoError(t, err)
		now = now.Add(time.Hour)
		_, err = tx.CloseSprint(a.ID, &b.ID, actor)
		require.NoError(t, err)
		child, err = tx.Issue(child.ID)
		require.NoError(t, err)
		require.Nil(t, child.Sprint)
		assertLedgerRecount(t, tx, b.ID)
		return nil
	}))
}
func TestSprintDatesDefaultsAndIsolation(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "dates"))
	require.NoError(t, db.EnsureWorkspace(t.Context(), "other"))
	now := sprintClock("2026-11-01T23:30:00Z")
	db.Now = func() time.Time { return now } // Monday in Tokyo
	var id string
	require.NoError(t, db.InWorkspace(t.Context(), "dates", true, func(tx *Tx) error {
		weeks := 2
		_, err := tx.PatchWorkspace(nil, nil, &weeks, nil)
		require.NoError(t, err)
		a, err := tx.CreateSprint(SprintCreate{})
		require.NoError(t, err)
		id = a.ID
		require.Equal(t, "2026-11-09", a.StartsOn)
		require.Equal(t, "2026-11-22", a.EndsOn)
		b, err := tx.CreateSprint(SprintCreate{})
		require.NoError(t, err)
		require.Equal(t, "2026-11-23", b.StartsOn)
		_, err = tx.CreateSprint(sprintInput("2026-11-22", 1))
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, 409, conflict.Status)
		a, err = tx.StartSprint(a.ID)
		require.NoError(t, err)
		require.Equal(t, "2026-11-02", a.StartsOn)
		require.Equal(t, "2026-11-15", a.EndsOn)
		_, err = tx.PatchSprint(a.ID, sprintInput("2026-11-03", 1))
		require.ErrorAs(t, err, &conflict)
		return nil
	}))
	require.NoError(t, db.InWorkspace(t.Context(), "other", true, func(tx *Tx) error {
		_, err := tx.Sprint(id)
		require.Error(t, err)
		_, err = tx.CreateIssue(IssueCreate{Title: "Foreign", Type: "task", SprintID: &id}, domain.Person{Sub: "x"}, nil)
		var fieldErr *domain.FieldError
		require.ErrorAs(t, err, &fieldErr)
		require.Equal(t, "sprintId", fieldErr.Path)
		return nil
	}))
}
func TestSprintChartsTimezoneAndProject(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "charts"))
	now := sprintClock("2026-11-01T12:00:00Z")
	db.Now = func() time.Time { return now }
	actor := domain.Actor{Person: domain.Person{Sub: "alex", Name: "Alex"}, Role: "Admin"}
	require.NoError(t, db.InWorkspace(t.Context(), "charts", true, func(tx *Tx) error {
		s, err := tx.CreateSprint(sprintInput("2026-11-02", 1))
		require.NoError(t, err)
		project, err := tx.CreateProject(ProjectCreate{Name: "Dashboard"}, actor)
		require.NoError(t, err)
		size := "M"
		a, err := tx.CreateIssue(IssueCreate{Title: "Sized", Type: "task", Estimate: &size, SprintID: &s.ID, ProjectID: &project.ID}, actor.Person, nil)
		require.NoError(t, err)
		_, err = tx.CreateIssue(IssueCreate{Title: "Unestimated", Type: "task", SprintID: &s.ID}, actor.Person, nil)
		require.NoError(t, err)
		now = sprintClock("2026-11-02T00:00:00Z")
		s, err = tx.StartSprint(s.ID)
		require.NoError(t, err)
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		var done string
		for _, status := range statuses {
			if status.Category == "completed" {
				done = status.ID
			}
		}
		now = sprintClock("2026-11-02T15:00:00Z") // midnight Tokyo, must fall on day two
		_, err = tx.PatchIssue(a.ID, IssuePatch{StatusID: field(done)}, actor.Person, nil)
		require.NoError(t, err)
		now = now.Add(time.Hour)
		chart, err := tx.Burndown(s.ID, "points", project.ID)
		require.NoError(t, err)
		require.Equal(t, "2026-11-03", chart.Today)
		require.Equal(t, 3, *chart.Points[0].Remaining)
		require.Zero(t, *chart.Points[1].Remaining)
		require.Nil(t, chart.Points[2].Scope)
		issues, err := tx.Burndown(s.ID, "issues", "none")
		require.NoError(t, err)
		require.Equal(t, 1, *issues.Points[0].Scope)
		// Current project membership controls historical chart attribution.
		_, err = tx.PatchIssue(a.ID, IssuePatch{ProjectID: Field[string]{Present: true}}, actor.Person, nil)
		require.NoError(t, err)
		chart, err = tx.Burndown(s.ID, "points", project.ID)
		require.NoError(t, err)
		require.Zero(t, *chart.Points[0].Scope)
		now = sprintClock("2026-11-10T02:00:00Z") // overdue close, last scheduled day includes close
		closed, err := tx.CloseSprint(s.ID, nil, actor.Person)
		require.NoError(t, err)
		chart, err = tx.Burndown(s.ID, "points", "")
		require.NoError(t, err)
		require.Equal(t, 3, *chart.Points[6].Done)
		velocity, err := tx.Velocity("points", "", 1)
		require.NoError(t, err)
		require.Equal(t, 3.0, *velocity.AveragePerWeek)
		for name, v := range map[string]any{"Sprint": closed, "Burndown": chart, "Velocity": velocity} {
			data, err := json.Marshal(v)
			require.NoError(t, err)
			t.Logf("%s JSON: %s", name, data)
		}
		return nil
	}))
}
func TestSprintEstimatePagingAndProgress(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "sorting"))
	actor := domain.Person{Sub: "alex"}
	require.NoError(t, db.InWorkspace(t.Context(), "sorting", true, func(tx *Tx) error {
		s, err := tx.CreateSprint(sprintInput("2026-11-02", 1))
		require.NoError(t, err)
		story, err := tx.CreateIssue(IssueCreate{Title: "Story", Type: "story"}, actor, nil)
		require.NoError(t, err)
		for _, size := range []string{"XS", "M", "XL", "L", "S", ""} {
			var estimate *string
			if size != "" {
				v := size
				estimate = &v
			}
			_, err := tx.CreateIssue(IssueCreate{Title: "Child", Type: "task", ParentID: &story.ID, Estimate: estimate, SprintID: &s.ID}, actor, nil)
			require.NoError(t, err)
		}
		story, err = tx.Issue(story.ID)
		require.NoError(t, err)
		require.Equal(t, 19, story.Progress.Points.Total)
		got := []string{}
		cursor := ""
		for {
			page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Sprint: []string{s.ID}}, Sort: domain.SortEstimate, Limit: 2, Cursor: cursor})
			require.NoError(t, err)
			for _, item := range page.Items {
				size := ""
				if item.Estimate != nil {
					size = *item.Estimate
				}
				got = append(got, size)
			}
			if page.NextCursor == nil {
				break
			}
			cursor = *page.NextCursor
		}
		require.Equal(t, []string{"XL", "L", "M", "S", "XS", ""}, got)
		page, err := tx.ListIssues(ListOptions{Filter: domain.Filter{Sprint: []string{"active"}}})
		require.NoError(t, err)
		require.Empty(t, page.Items)
		page, err = tx.ListIssues(ListOptions{Filter: domain.Filter{Sprint: []string{"none"}}})
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
		return nil
	}))
}

func TestSprintSeedFixture(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	now := sprintClock("2026-11-11T03:00:00Z")
	db.Now = func() time.Time { return now }
	require.NoError(t, db.SeedDev(t.Context(), "seed"))
	require.NoError(t, db.SeedDev(t.Context(), "seed"))
	require.NoError(t, db.InWorkspace(t.Context(), "seed", false, func(tx *Tx) error {
		workspace, err := tx.Workspace()
		require.NoError(t, err)
		require.Equal(t, 40, workspace.IssueCount)
		sprints, err := tx.Sprints("")
		require.NoError(t, err)
		require.Len(t, sprints, 5)
		require.Equal(t, []int64{4, 5, 3, 2, 1}, []int64{sprints[0].Number, sprints[1].Number, sprints[2].Number, sprints[3].Number, sprints[4].Number})
		active, planned := sprints[0], sprints[1]
		require.Equal(t, "2026-11-08", active.StartsOn)
		require.Equal(t, "2026-11-21", active.EndsOn)
		require.Equal(t, domain.Tally{ScopePoints: 10, ScopeIssues: 6}, active.Current)
		require.Equal(t, active.Current, *active.Commitment)
		require.Equal(t, domain.Tally{ScopePoints: 4, ScopeIssues: 3}, planned.Current)
		require.Nil(t, planned.Commitment)
		assertLedgerRecount(t, tx, active.ID)
		assertLedgerRecount(t, tx, planned.ID)
		page, err := tx.ListIssues(ListOptions{Sort: domain.SortNumber})
		require.NoError(t, err)
		sized := 0
		sizes := map[string]bool{}
		for _, issue := range page.Items {
			if issue.Estimate != nil {
				sized++
				sizes[*issue.Estimate] = true
			}
		}
		require.Equal(t, 17, sized)
		require.Len(t, sizes, 5)
		require.Equal(t, "Speed up issue search", page.Items[36].Title)
		require.Equal(t, "Show issue counts per project", page.Items[39].Title)
		velocity, err := tx.Velocity("points", "", 8)
		require.NoError(t, err)
		require.Len(t, velocity.Items, 3)
		for i, entry := range velocity.Items {
			require.Equal(t, 18+3*i, entry.Completed)
			require.Equal(t, 21+3*i, entry.Committed)
		}
		require.Equal(t, 21.0, *velocity.AveragePerWeek)
		limited, err := tx.Velocity("points", "", 1)
		require.NoError(t, err)
		require.Len(t, limited.Items, 1)
		require.Equal(t, 24, limited.Items[0].Completed)
		require.Equal(t, 21.0, *limited.AveragePerWeek)
		issues, err := tx.Velocity("issues", "", 8)
		require.NoError(t, err)
		require.Equal(t, 3.0, *issues.AveragePerWeek)
		chart, err := tx.Burndown(active.ID, "points", "")
		require.NoError(t, err)
		require.Len(t, chart.Points, 14)
		require.Equal(t, 10, *chart.Points[0].Scope)
		require.Equal(t, 12, *chart.Points[1].Scope)
		require.Equal(t, 10, *chart.Points[2].Scope)
		require.Nil(t, chart.Points[4].Scope)
		return nil
	}))
}

func TestSprintVelocityMixedLengthsAndRounding(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "velocity"))
	now := sprintClock("2026-01-01T00:00:00Z")
	db.Now = func() time.Time { return now }
	actor := domain.Person{Sub: "alex"}
	require.NoError(t, db.InWorkspace(t.Context(), "velocity", true, func(tx *Tx) error {
		statuses, err := tx.Statuses()
		require.NoError(t, err)
		var done string
		for _, s := range statuses {
			if s.Category == "completed" {
				done = s.ID
			}
		}
		for _, fixture := range []struct {
			start, size string
			weeks       int
		}{{"2026-01-01", "M", 1}, {"2026-01-08", "XS", 1}, {"2026-01-15", "L", 2}, {"2026-01-29", "XL", 1}} {
			start, err := time.Parse("2006-01-02", fixture.start)
			require.NoError(t, err)
			now = start.Add(-time.Hour)
			s, err := tx.CreateSprint(sprintInput(fixture.start, fixture.weeks))
			require.NoError(t, err)
			issue, err := tx.CreateIssue(IssueCreate{Title: "Member", Type: "task", Estimate: &fixture.size, SprintID: &s.ID}, actor, nil)
			require.NoError(t, err)
			now = start
			_, err = tx.StartSprint(s.ID)
			require.NoError(t, err)
			now = start.Add(time.Hour)
			_, err = tx.PatchIssue(issue.ID, IssuePatch{StatusID: field(done)}, actor, nil)
			require.NoError(t, err)
			now = start.AddDate(0, 0, 7*fixture.weeks-1)
			_, err = tx.CloseSprint(s.ID, nil, actor)
			require.NoError(t, err)
		}
		for _, unit := range []string{"points", "issues"} {
			v, err := tx.Velocity(unit, "", 2)
			require.NoError(t, err)
			require.Len(t, v.Items, 2)
			require.Equal(t, int64(3), v.Items[0].Sprint.Number)
			require.Equal(t, int64(4), v.Items[1].Sprint.Number)
			if unit == "points" {
				require.Equal(t, 3.83, *v.AveragePerWeek)
			} else {
				require.Equal(t, 0.83, *v.AveragePerWeek)
			}
		}
		return nil
	}))
}

func TestSprintConcurrentOverlap(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "concurrent"))
	results := make(chan error, 2)
	for range 2 {
		go func() {
			results <- db.InWorkspace(t.Context(), "concurrent", true, func(tx *Tx) error { _, err := tx.CreateSprint(sprintInput("2026-11-02", 1)); return err })
		}()
	}
	success, conflicts := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			success++
			continue
		}
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, 409, conflict.Status)
		conflicts++
	}
	require.Equal(t, 1, success)
	require.Equal(t, 1, conflicts)
}

func TestSprintStartOverlapAndDST(t *testing.T) {
	db, _ := testutil.Database(t, Open)
	require.NoError(t, db.EnsureWorkspace(t.Context(), "dst"))
	now := sprintClock("2026-10-30T16:00:00Z")
	db.Now = func() time.Time { return now }
	require.NoError(t, db.InWorkspace(t.Context(), "dst", true, func(tx *Tx) error {
		timezone := "America/New_York"
		_, err := tx.PatchWorkspace(nil, nil, nil, &timezone)
		require.NoError(t, err)
		a, err := tx.CreateSprint(sprintInput("2026-10-31", 1))
		require.NoError(t, err)
		b, err := tx.CreateSprint(sprintInput("2026-11-07", 1))
		require.NoError(t, err)
		_, err = tx.StartSprint(b.ID)
		var conflict *httpx.Error
		require.ErrorAs(t, err, &conflict)
		require.Equal(t, 409, conflict.Status)
		actor := domain.Person{Sub: "alex"}
		size := "S"
		_, err = tx.CreateIssue(IssueCreate{Title: "DST", Type: "task", Estimate: &size, SprintID: &a.ID}, actor, nil)
		require.NoError(t, err)
		now = sprintClock("2026-10-31T16:00:00Z")
		a, err = tx.StartSprint(a.ID)
		require.NoError(t, err)
		now = sprintClock("2026-11-02T04:30:00Z") // still Nov 1 after clocks go back
		chart, err := tx.Burndown(a.ID, "issues", "")
		require.NoError(t, err)
		require.Equal(t, "2026-11-01", chart.Today)
		require.Equal(t, 1, *chart.Points[1].Remaining)
		require.Nil(t, chart.Points[2].Scope)
		return nil
	}))
}
