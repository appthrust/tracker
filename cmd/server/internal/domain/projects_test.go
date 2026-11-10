package domain

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateProject(t *testing.T) {
	for _, tc := range []struct {
		name, description, color string
		valid                    bool
	}{
		{"Dashboard", "", "blue", true},
		{strings.Repeat("あ", 60), strings.Repeat("x", 4096), "gray", true},
		{"", "", "blue", false}, {"   ", "", "blue", false},
		{strings.Repeat("あ", 61), "", "blue", false},
		{"Dashboard", strings.Repeat("x", 4097), "blue", false},
		{"Dashboard", strings.Repeat("あ", 1366), "blue", false},
		{"Dashboard", "\xff", "blue", false},
		{"Dashboard", "", "unknown", false},
	} {
		require.Equal(t, tc.valid, ValidateProject(Project{Name: tc.name, Description: tc.description, Color: tc.color}) == nil, "%+v", tc)
	}
	for _, color := range Colors {
		require.NoError(t, ValidateProject(Project{Name: "Project", Color: color}))
	}
}

func TestProjectPermissions(t *testing.T) {
	for _, role := range []string{"Viewer", "Editor", "Admin"} {
		for _, action := range []Action{CreateProject, EditProject, ArchiveProject, DeleteProject} {
			want := action == CreateProject || action == EditProject || role == "Admin"
			require.Equal(t, want, Can(Actor{Person: Person{Sub: "user"}, Role: role}, action, Target{}), "%s %s", role, action)
			require.False(t, Can(Actor{Role: role}, action, Target{}))
		}
	}
}

func TestProjectFilter(t *testing.T) {
	for _, tc := range []struct {
		values []string
		valid  bool
	}{
		{nil, true}, {[]string{}, true}, {[]string{"none"}, true},
		{[]string{"01ARZ3NDEKTSV4RRFFQ69G5FAV", "none"}, true},
		{[]string{"bad"}, false}, {[]string{""}, false}, {[]string{"me"}, false},
	} {
		require.Equal(t, tc.valid, ValidateFilter(Filter{Project: tc.values}) == nil, "%v", tc.values)
	}
}
