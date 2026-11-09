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
	}{{"image/png", 2 << 20, true}, {"text/plain", 1, true}, {"application/json", 0, false}, {"image/png", (2 << 20) + 1, false}, {"text/html", 1, false}} {
		require.Equal(t, tc.valid, ValidateAttachment("file", tc.media, tc.size) == nil)
	}
}
