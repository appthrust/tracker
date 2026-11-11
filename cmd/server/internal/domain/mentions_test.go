package domain

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMentionHandles(t *testing.T) {
	for _, tc := range []struct {
		body    string
		handles []string
	}{
		{"No mentions", []string{}},
		{"@astra and @opus-ui, @astra again", []string{"astra", "opus-ui"}},
		{"(@astra) **@claude**", []string{"astra", "claude"}},
		{"name@astra.example @Astra @a @astra_more @@astra", []string{}},
		{"@" + strings.Repeat("a", 31) + " @" + strings.Repeat("b", 32), []string{strings.Repeat("a", 31)}},
		{"@astraさん text@astra @astra.", []string{"astra"}},
	} {
		require.Equal(t, tc.handles, MentionHandles(tc.body), tc.body)
	}
}

func TestAgentFilters(t *testing.T) {
	for _, tc := range []struct {
		filter Filter
		valid  bool
	}{
		{Filter{AssigneeKind: []string{"person", "agent"}}, true},
		{Filter{AssigneeKind: []string{"robot"}}, false},
		{Filter{Agent: []string{"01M74SFSZ657XZ2HNWWA9VND8T"}}, true},
		{Filter{Agent: []string{"astra"}}, false},
		{Filter{Run: []string{"active", "stalled", "none"}}, true},
		{Filter{Run: []string{"running"}}, false},
		{Filter{Request: []string{"open", "mine"}}, true},
		{Filter{Request: []string{"answered"}}, false},
	} {
		require.Equal(t, tc.valid, ValidateFilter(tc.filter) == nil, "%+v", tc.filter)
	}
}
