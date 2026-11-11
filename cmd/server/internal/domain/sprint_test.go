package domain

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSizePoints(t *testing.T) {
	for _, tc := range []struct {
		size   string
		points int
	}{{"XS", 1}, {"S", 2}, {"M", 3}, {"L", 5}, {"XL", 8}, {"", 0}, {"3", 0}, {"xxl", 0}} {
		t.Run(tc.size, func(t *testing.T) { require.Equal(t, tc.points, SizePoints(tc.size)) })
	}
}
func TestContribution(t *testing.T) {
	for _, tc := range []struct {
		name     string
		standing SprintStanding
		want     SprintTally
	}{
		{"unassigned", SprintStanding{Size: "XL", Category: "completed"}, SprintTally{}},
		{"unestimated", SprintStanding{SprintID: "s", Category: "backlog"}, SprintTally{ScopeIssues: 1}},
		{"open", SprintStanding{SprintID: "s", Size: "M", Category: "started"}, SprintTally{ScopePoints: 3, ScopeIssues: 1}},
		{"done", SprintStanding{SprintID: "s", Size: "L", Category: "completed"}, SprintTally{5, 1, 5, 1}},
		{"canceled", SprintStanding{SprintID: "s", Size: "XL", Category: "canceled"}, SprintTally{}},
		{"deleted", SprintStanding{SprintID: "s", Size: "M", Category: "completed", Deleted: true}, SprintTally{}},
	} {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, Contribution(tc.standing)) })
	}
}
func TestSprintDeltas(t *testing.T) {
	open := SprintStanding{SprintID: "a", Size: "M", Category: "started"}
	done := open
	done.Category = "completed"
	cancel := open
	cancel.Category = "canceled"
	deleted := done
	deleted.Deleted = true
	bigger := open
	bigger.Size = "XL"
	moved := open
	moved.SprintID = "b"
	for _, tc := range []struct {
		name          string
		before, after SprintStanding
		want          map[string]SprintTally
	}{
		{"join", SprintStanding{}, open, map[string]SprintTally{"a": {3, 1, 0, 0}}},
		{"move", open, moved, map[string]SprintTally{"a": {-3, -1, 0, 0}, "b": {3, 1, 0, 0}}},
		{"estimate", open, bigger, map[string]SprintTally{"a": {5, 0, 0, 0}}},
		{"complete", open, done, map[string]SprintTally{"a": {0, 0, 3, 1}}},
		{"reopen", done, open, map[string]SprintTally{"a": {0, 0, -3, -1}}},
		{"cancel", open, cancel, map[string]SprintTally{"a": {-3, -1, 0, 0}}},
		{"uncancel", cancel, open, map[string]SprintTally{"a": {3, 1, 0, 0}}},
		{"delete", done, deleted, map[string]SprintTally{"a": {-3, -1, -3, -1}}},
		{"clear", open, SprintStanding{}, map[string]SprintTally{"a": {-3, -1, 0, 0}}},
		{"unchanged", open, open, map[string]SprintTally{}},
		{"empty", SprintStanding{}, SprintStanding{}, map[string]SprintTally{}},
	} {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, SprintDeltas(tc.before, tc.after)) })
	}
}
func sprintDate(s string) time.Time {
	v, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return v
}
func TestValidateSprintDates(t *testing.T) {
	for _, tc := range []struct {
		name, start string
		weeks       int
		others      []SprintSpan
		valid       bool
	}{
		{"one week", "2026-11-02", 1, nil, true},
		{"two weeks", "2026-11-02", 2, nil, true},
		{"invalid length", "2026-11-02", 3, nil, false},
		{"zero length", "2026-11-02", 0, nil, false},
		{"adjacent one week", "2026-11-02", 1, []SprintSpan{{sprintDate("2026-11-09"), sprintDate("2026-11-15")}}, true},
		{"inclusive overlap", "2026-11-02", 1, []SprintSpan{{sprintDate("2026-11-08"), sprintDate("2026-11-14")}}, false},
		{"two week overlap", "2026-11-02", 2, []SprintSpan{{sprintDate("2026-11-09"), sprintDate("2026-11-15")}}, false},
		{"adjacent two weeks", "2026-11-02", 2, []SprintSpan{{sprintDate("2026-11-16"), sprintDate("2026-11-22")}}, true},
		{"contained", "2026-11-02", 1, []SprintSpan{{sprintDate("2026-11-01"), sprintDate("2026-11-15")}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.valid, ValidateSprintDates(sprintDate(tc.start), tc.weeks, tc.others) == nil)
		})
	}
	require.Error(t, ValidateSprintDates(time.Time{}, 1, nil))
}
func TestValidateMembership(t *testing.T) {
	for _, tc := range []struct {
		kind, state string
		lineage     int
		valid       bool
	}{
		{"story", "planned", 0, true}, {"task", "active", 0, true}, {"bug", "planned", 0, true},
		{"epic", "active", 0, false}, {"task", "closed", 0, false}, {"task", "", 0, false},
		{"story", "active", 1, false}, {"task", "planned", 2, false},
	} {
		err := ValidateMembership(tc.kind, tc.state, tc.lineage)
		require.Equal(t, tc.valid, err == nil)
		if err != nil {
			require.Equal(t, "sprintId", err.(*FieldError).Path)
		}
	}
}
func TestBurndown(t *testing.T) {
	start := sprintDate("2026-11-06") // Friday
	events := []SprintEvent{
		{start.Add(-time.Hour), SprintTally{10, 3, 0, 0}},
		{start.AddDate(0, 0, 1).Add(time.Hour), SprintTally{0, 0, 3, 1}},
		{start.AddDate(0, 0, 2).Add(time.Hour), SprintTally{5, 1, 0, 0}},
		{start.AddDate(0, 0, 3).Add(time.Hour), SprintTally{-2, -1, 0, 0}},
	}
	for _, unit := range []string{"points", "issues"} {
		t.Run(unit, func(t *testing.T) {
			days := make([]Day, 7)
			for i := range days {
				date := start.AddDate(0, 0, i)
				days[i] = Day{Date: date, Until: date.AddDate(0, 0, 1), Future: i > 3, Unit: unit}
			}
			points := Burndown(SprintTally{10, 3, 0, 0}, events, days)
			require.Len(t, points, 7)
			if unit == "points" {
				require.Equal(t, 10, *points[0].Remaining)
				require.Equal(t, 7, *points[1].Remaining)
				require.Equal(t, 15, *points[2].Scope)
				require.Equal(t, 10, *points[3].Remaining)
				require.Equal(t, 10.0, points[0].Ideal)
				require.Equal(t, 10.0, points[1].Ideal)
				require.Equal(t, 10.0, points[2].Ideal)
				require.Equal(t, 7.5, points[3].Ideal)
			} else {
				require.Equal(t, 3, *points[0].Scope)
				require.Equal(t, 1, *points[1].Done)
				require.Equal(t, 2, *points[3].Remaining)
			}
			require.Zero(t, points[6].Ideal)
			for _, p := range points[4:] {
				require.Nil(t, p.Scope)
				require.Nil(t, p.Done)
				require.Nil(t, p.Remaining)
				raw, err := json.Marshal(p)
				require.NoError(t, err)
				require.NotContains(t, string(raw), "remaining")
			}
		})
	}
	require.Empty(t, Burndown(SprintTally{}, nil, nil))
}
func TestBurndownTwoWeeksRounding(t *testing.T) {
	start := sprintDate("2026-11-02")
	days := make([]Day, 14)
	for i := range days {
		d := start.AddDate(0, 0, i)
		days[i] = Day{Date: d, Until: d.AddDate(0, 0, 1)}
	}
	points := Burndown(SprintTally{ScopePoints: 10}, nil, days)
	require.Equal(t, 8.89, points[1].Ideal)
	require.Equal(t, points[4].Ideal, points[5].Ideal)
	require.Equal(t, points[5].Ideal, points[6].Ideal)
	require.Zero(t, points[11].Ideal)
	require.Zero(t, points[12].Ideal)
	require.Zero(t, points[13].Ideal)
}
func TestSprintFilterAndEstimateValidation(t *testing.T) {
	for _, value := range []string{"active", "none", "01ARZ3NDEKTSV4RRFFQ69G5FAV"} {
		require.NoError(t, ValidateFilter(Filter{Sprint: []string{value}}))
	}
	for _, value := range []string{"", "me", "bad"} {
		err := ValidateFilter(Filter{Sprint: []string{value}})
		require.Error(t, err)
		require.Equal(t, "filter.sprint", err.(*FieldError).Path)
	}
	require.True(t, ValidSort(SortEstimate))
	require.NoError(t, ValidateView(View{Name: "Sprint", Layout: "board", GroupBy: "sprint", Sort: SortEstimate}))
	for _, tc := range []struct {
		kind, size string
		valid      bool
	}{{"task", "XS", true}, {"story", "XL", true}, {"epic", "M", false}, {"task", "3", false}, {"task", "", false}} {
		err := ValidateIssue(Issue{IssueSummary: IssueSummary{Title: "Work", Type: tc.kind, Priority: "none", Estimate: &tc.size}})
		require.Equal(t, tc.valid, err == nil)
		if err != nil {
			require.Equal(t, "estimate", err.(*FieldError).Path)
		}
	}
}
