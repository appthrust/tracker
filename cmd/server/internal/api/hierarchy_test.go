package api

import (
	"encoding/json"
	"net/url"
	"testing"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestHierarchyRequestsAndValidation(t *testing.T) {
	h := newHarness(t)
	epic := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]string{"title": "Epic", "type": "epic"}, 201)
	story := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]string{"title": "Story", "type": "story", "parentId": epic.ID}, 201)
	task := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]string{"title": "Task", "type": "task", "parentId": story.ID}, 201)
	require.Equal(t, epic.ID, task.Epic.ID)
	require.Equal(t, story.ID, task.Story.ID)
	epic = call[domain.Issue](h, "viewer", "GET", "/issues/"+epic.ID, nil, 200)
	require.Equal(t, &domain.Progress{Total: 1}, epic.Progress)
	for _, tc := range []struct {
		method, route, path string
		body                map[string]any
	}{
		{"POST", "/issues", "parentId", map[string]any{"title": "Invalid", "type": "epic", "parentId": epic.ID}},
		{"POST", "/issues", "parentId", map[string]any{"title": "Invalid", "type": "story", "parentId": story.ID}},
		{"POST", "/issues", "parentId", map[string]any{"title": "Invalid", "type": "story", "parentId": task.ID}},
		{"PATCH", "/issues/" + epic.ID, "type", map[string]any{"type": "story"}},
		{"PATCH", "/issues/" + task.ID, "type", map[string]any{"type": "epic"}},
		{"PATCH", "/issues/" + task.ID, "parentId", map[string]any{"type": "story", "parentId": task.ID}},
	} {
		body := call[struct {
			Code    string              `json:"error"`
			Message string              `json:"message"`
			Issues  []domain.FieldError `json:"issues"`
		}](h, "viewer", tc.method, tc.route, tc.body, 400)
		require.Equal(t, "invalid", body.Code)
		require.Len(t, body.Issues, 1)
		require.Equal(t, tc.path, body.Issues[0].Path)
		require.Equal(t, body.Message, body.Issues[0].Message)
	}
	for _, tc := range []struct {
		filter domain.Filter
		count  int
	}{
		{domain.Filter{Epic: []string{epic.ID}}, 2},
		{domain.Filter{Epic: []string{"none"}}, 1},
		{domain.Filter{Story: []string{story.ID}}, 1},
		{domain.Filter{Story: []string{"none"}}, 2},
	} {
		filter, err := json.Marshal(tc.filter)
		require.NoError(t, err)
		page := call[store.Page](h, "viewer", "GET", "/issues?filter="+url.QueryEscape(string(filter)), nil, 200)
		require.Len(t, page.Items, tc.count)
	}
	for _, filter := range []string{`{"epic":["APT-1"]}`, `{"story":[""]}`} {
		call[any](h, "viewer", "GET", "/issues?filter="+url.QueryEscape(filter), nil, 400)
	}
	task = call[domain.Issue](h, "viewer", "PATCH", "/issues/"+task.ID, map[string]any{"parentId": nil}, 200)
	require.Nil(t, task.Epic)
	require.Nil(t, task.Story)
	body := call[map[string]any](h, "viewer", "GET", "/issues/"+task.ID, nil, 200)
	for _, field := range []string{"epic", "story", "progress"} {
		require.Contains(t, body, field)
		require.Nil(t, body[field])
	}
}

func TestViewGroupingRequests(t *testing.T) {
	h := newHarness(t)
	view := call[domain.View](h, "viewer", "POST", "/views", map[string]string{"name": "Default"}, 201)
	require.Equal(t, "none", view.GroupBy)
	for _, group := range []string{"epic", "story", "none"} {
		created := call[domain.View](h, "viewer", "POST", "/views", map[string]any{"name": group, "groupBy": group, "filter": domain.Filter{Epic: []string{"none"}, Story: []string{"none"}}}, 201)
		require.Equal(t, group, created.GroupBy)
		updated := call[domain.View](h, "viewer", "PATCH", "/views/"+view.ID, map[string]string{"groupBy": group}, 200)
		require.Equal(t, group, updated.GroupBy)
		views := call[items[domain.View]](h, "viewer", "GET", "/views", nil, 200)
		require.Contains(t, views.Items, created)
		require.Contains(t, views.Items, updated)
	}
	for _, group := range []any{"", "status", nil} {
		call[any](h, "viewer", "POST", "/views", map[string]any{"name": "Invalid", "groupBy": group}, 400)
		call[any](h, "viewer", "PATCH", "/views/"+view.ID, map[string]any{"groupBy": group}, 400)
	}
}
