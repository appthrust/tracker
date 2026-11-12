package domain

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestIdentifiers(t *testing.T) {
	for _, tc := range []struct {
		raw, key string
		number   int64
		valid    bool
	}{{"apt-12", "APT", 12, true}, {"A9-1", "A9", 1, true}, {"A-1", "", 0, false}, {"APT-0", "", 0, false}, {"APT-01", "", 0, false}, {"APT-+1", "", 0, false}, {"APT-9223372036854775808", "", 0, false}, {" APT-1", "", 0, false}} {
		t.Run(tc.raw, func(t *testing.T) {
			key, number, err := ParseIdentifier(tc.raw)
			require.Equal(t, tc.valid, err == nil)
			require.Equal(t, tc.key, key)
			require.Equal(t, tc.number, number)
			if tc.valid {
				require.Equal(t, strings.ToUpper(tc.raw), FormatIdentifier(key, number))
			}
		})
	}
}
func TestTransitions(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		category string
		want     *time.Time
	}{{"completed", &now}, {"canceled", &now}, {"started", nil}, {"backlog", nil}, {"unstarted", nil}} {
		require.Equal(t, tc.want, TransitionCompletedAt(tc.category, now))
	}
}
func TestCan(t *testing.T) {
	for _, tc := range []struct {
		subject, role string
		action        Action
		target        Target
		want          bool
	}{
		{"", "Admin", Read, Target{}, false}, {"user", "Viewer", EditIssue, Target{}, true}, {"user", "Viewer", Create, Target{}, true},
		{"user", "Editor", ManageWorkspace, Target{}, false}, {"user", "Admin", ManageWorkspace, Target{}, true}, {"user", "Admin", DeleteIssue, Target{}, true},
		{"user", "Admin", EditComment, Target{OwnerSub: "other"}, false}, {"user", "Viewer", EditComment, Target{OwnerSub: "user"}, true},
		{"user", "Admin", DeleteComment, Target{OwnerSub: "other"}, true}, {"user", "Viewer", DeleteAttachment, Target{OwnerSub: "other"}, false},
		{"user", "Viewer", CreateView, Target{Shared: true}, false}, {"user", "Viewer", CreateView, Target{}, true},
		{"user", "Viewer", ManageView, Target{OwnerSub: "user", Shared: true}, false}, {"user", "Admin", ManageView, Target{OwnerSub: "other", Shared: true}, true},
		{"user", "Admin", ManageView, Target{OwnerSub: "other"}, false}, {"user", "Viewer", ManageView, Target{OwnerSub: "user"}, true},
		{"user", "Admin", "unknown", Target{}, false},
	} {
		require.Equal(t, tc.want, Can(Actor{Person: Person{Sub: tc.subject}, Role: tc.role}, tc.action, tc.target), "%+v", tc)
	}
}
func TestParentCycle(t *testing.T) {
	parents := map[string]string{"b": "c", "c": "a", "x": "y", "y": "x"}
	for _, tc := range []struct {
		id, parent string
		cycle      bool
	}{{"a", "", false}, {"a", "a", true}, {"a", "b", true}, {"d", "b", false}, {"d", "x", true}} {
		require.Equal(t, tc.cycle, ParentCycle(tc.id, tc.parent, parents))
	}
}
func TestReportAndFilters(t *testing.T) {
	valid := &Report{Environment: "local", Surface: "dashboard"}
	for _, tc := range []struct {
		kind   string
		report *Report
		valid  bool
	}{{"bug", valid, true}, {"bug", nil, false}, {"task", valid, false}, {"feature", nil, true}, {"bug", &Report{Surface: "dashboard"}, false}, {"bug", &Report{Environment: "local", Surface: "bad"}, false}, {"bug", &Report{Environment: "local", Surface: "apth", Steps: strings.Repeat("あ", 4097)}, false}} {
		require.Equal(t, tc.valid, ValidateReport(tc.kind, tc.report) == nil)
	}
	for _, tc := range []struct {
		filter Filter
		valid  bool
	}{{Filter{}, true}, {Filter{Category: []string{"started"}, Assignee: []string{"me", "none"}, CreatedAfter: "2026-01-01T00:00:00Z"}, true}, {Filter{Type: []string{"invalid"}}, false}, {Filter{Status: []string{"bad"}}, false}, {Filter{CreatedAfter: "yesterday"}, false}, {Filter{Parent: "none"}, true}, {Filter{Parent: "bad"}, false}, {Filter{Surface: []string{"apth"}}, true}} {
		require.Equal(t, tc.valid, ValidateFilter(tc.filter) == nil)
	}
	for _, sort := range []Sort{SortUpdated, SortCreated, SortNumber, SortPriority} {
		require.True(t, ValidSort(sort))
	}
	require.False(t, ValidSort("bad"))
	statuses := DefaultStatuses()
	require.Len(t, statuses, 6)
	for _, category := range Categories {
		found := false
		for _, status := range statuses {
			if category == status.Category {
				found = true
			}
		}
		require.True(t, found)
	}
}

func TestReporterFilterValidation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reporter []string
		message  string
	}{
		{name: "omitted"},
		{name: "empty list", reporter: []string{}},
		{name: "caller", reporter: []string{"me"}},
		{name: "explicit subject", reporter: []string{"alex"}},
		{name: "multiple subjects", reporter: []string{"me", "other"}},
		{name: "20 entries", reporter: strings.Fields(strings.Repeat("alex ", 20))},
		{name: "4096 characters", reporter: []string{strings.Repeat("あ", 4096)}},
		{name: "too many entries", reporter: strings.Fields(strings.Repeat("alex ", 21)), message: "Reporter filter must contain at most 20 entries"},
		{name: "empty subject", reporter: []string{""}, message: "Filter values must contain 1 to 4096 characters"},
		{name: "blank subject", reporter: []string{" \t\n"}, message: "Filter values must contain 1 to 4096 characters"},
		{name: "long subject", reporter: []string{strings.Repeat("あ", 4097)}, message: "Filter values must contain 1 to 4096 characters"},
		{name: "invalid UTF-8", reporter: []string{"\xff"}, message: "Filter values must contain 1 to 4096 characters"},
		{name: "none", reporter: []string{"none"}, message: "Reporter filter does not support none"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filter := Filter{Reporter: tc.reporter}
			for _, err := range []error{
				ValidateFilter(filter),
				ValidateView(View{Name: "Reported", Layout: "list", GroupBy: "none", Sort: SortCreated, Filter: filter}),
			} {
				if tc.message == "" {
					require.NoError(t, err)
					continue
				}
				var field *FieldError
				require.ErrorAs(t, err, &field)
				require.Equal(t, "filter.reporter", field.Path)
				require.Equal(t, tc.message, field.Message)
			}
		})
	}
}
func TestIssueAndAttachmentLimits(t *testing.T) {
	item := Issue{IssueSummary: IssueSummary{Title: "Valid", Type: "task", Priority: "none"}}
	require.NoError(t, ValidateIssue(item))
	item.Title = strings.Repeat("あ", 201)
	require.Error(t, ValidateIssue(item))
	item.Title = "Valid"
	item.Description = strings.Repeat("x", 51201)
	require.Error(t, ValidateIssue(item))
	for _, tc := range []struct {
		media string
		size  int
		valid bool
	}{{"image/png", AttachmentMaxBytes, true}, {"text/plain", 1, true}, {"application/json", 0, false}, {"image/png", AttachmentMaxBytes + 1, false}, {"text/html", 1, false}} {
		require.Equal(t, tc.valid, ValidateAttachment("file", tc.media, tc.size) == nil)
	}
}

func TestHierarchy(t *testing.T) {
	for _, tc := range []struct {
		kind  string
		level int
	}{{"epic", 2}, {"story", 1}, {"bug", 0}, {"feature", 0}, {"task", 0}, {"unknown", 0}} {
		require.Equal(t, tc.level, Level(tc.kind))
	}
	for _, child := range []string{"epic", "story", "bug", "feature", "task"} {
		for _, parent := range []string{"", "epic", "story", "bug", "feature", "task"} {
			t.Run(child+"/"+parent, func(t *testing.T) {
				valid := parent == "" || child == "bug" || child == "feature" || child == "task" || (child == "story" && parent == "epic")
				require.Equal(t, valid, ValidateHierarchy(child, parent) == nil)
			})
		}
		item := Issue{IssueSummary: IssueSummary{Title: "Valid", Type: child, Priority: "none"}}
		if child == "bug" {
			item.Report = &Report{Environment: "local", Surface: "apth"}
		}
		require.NoError(t, ValidateIssue(item))
	}
}

func TestHierarchyFiltersAndGrouping(t *testing.T) {
	id := "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	for _, tc := range []struct {
		name   string
		filter Filter
		valid  bool
	}{
		{"types", Filter{Type: []string{"epic", "story"}}, true},
		{"epic", Filter{Epic: []string{id, "none"}}, true},
		{"story", Filter{Story: []string{id, "none"}}, true},
		{"invalid epic", Filter{Epic: []string{"APT-1"}}, false},
		{"invalid story", Filter{Story: []string{"me"}}, false},
		{"empty epic", Filter{Epic: []string{""}}, false},
		{"empty story", Filter{Story: []string{""}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.valid, ValidateFilter(tc.filter) == nil)
			require.Equal(t, tc.valid, ValidateView(View{Name: "Grouped", Layout: "board", GroupBy: "epic", Sort: SortUpdated, Filter: tc.filter}) == nil)
		})
	}
	for _, tc := range []struct {
		group string
		valid bool
	}{{"none", true}, {"epic", true}, {"story", true}, {"", false}, {"status", false}} {
		require.Equal(t, tc.valid, ValidateView(View{Name: "Grouped", Layout: "list", GroupBy: tc.group, Sort: SortUpdated}) == nil)
	}
}
