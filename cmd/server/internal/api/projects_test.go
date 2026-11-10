package api

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestProjectLifecycleAndAuthorization(t *testing.T) {
	h := newHarness(t)
	call[any](h, "", "GET", "/projects", nil, 401)
	list := call[items[domain.Project]](h, "viewer", "GET", "/projects", nil, 200)
	require.NotNil(t, list.Items)
	require.Empty(t, list.Items)
	project := call[domain.Project](h, "viewer", "POST", "/projects", map[string]any{"name": "Dashboard", "description": "Product area", "color": "blue"}, 201)
	require.Equal(t, "Product area", project.Description)
	require.Equal(t, "blue", project.Color)
	require.False(t, project.Archived)
	got := call[domain.Project](h, "viewer", "GET", "/projects/"+project.ID, nil, 200)
	require.Equal(t, project, got)
	call[any](h, "viewer", "POST", "/projects", map[string]string{"name": "Dashboard"}, 409)
	other := call[domain.Project](h, "viewer", "POST", "/projects", map[string]string{"name": "API"}, 201)
	require.Equal(t, "gray", other.Color)
	call[any](h, "viewer", "PATCH", "/projects/"+other.ID, map[string]string{"name": "Dashboard"}, 409)
	for _, archived := range []bool{false, true} {
		call[any](h, "viewer", "PATCH", "/projects/"+project.ID, map[string]bool{"archived": archived}, 403)
	}
	call[any](h, "viewer", "DELETE", "/projects/"+other.ID, nil, 403)
	got = call[domain.Project](h, "viewer", "PATCH", "/projects/"+project.ID, map[string]string{"description": "Updated", "color": "purple"}, 200)
	require.Equal(t, "Updated", got.Description)
	require.Equal(t, "purple", got.Color)
	issue := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]any{"title": "Assigned", "type": "task", "projectId": project.ID}, 201)
	require.Equal(t, &project.ID, issue.ProjectID)
	errBody := call[httpx.Error](h, "admin", "DELETE", "/projects/"+project.ID, nil, 409)
	require.Equal(t, "conflict", errBody.Code)
	page := call[store.Page](h, "viewer", "GET", "/issues?filter="+url.QueryEscape(`{"project":["`+project.ID+`"]}`), nil, 200)
	require.Len(t, page.Items, 1)
	require.Equal(t, &project.ID, page.Items[0].ProjectID)
	view := call[domain.View](h, "viewer", "POST", "/views", map[string]any{"name": "Project work", "filter": domain.Filter{Project: []string{project.ID, "none"}}}, 201)
	require.Equal(t, []string{project.ID, "none"}, view.Filter.Project)
	got = call[domain.Project](h, "admin", "PATCH", "/projects/"+project.ID, map[string]bool{"archived": true}, 200)
	require.True(t, got.Archived)
	require.Equal(t, 1, got.IssueCount)
	require.Equal(t, 1, got.OpenIssueCount)
	list = call[items[domain.Project]](h, "viewer", "GET", "/projects", nil, 200)
	require.Len(t, list.Items, 1)
	list = call[items[domain.Project]](h, "viewer", "GET", "/projects?includeArchived=true", nil, 200)
	require.Len(t, list.Items, 2)
	call[domain.Project](h, "viewer", "GET", "/projects/"+project.ID, nil, 200)
	call[domain.Issue](h, "viewer", "PATCH", "/issues/"+issue.ID, map[string]string{"title": "Still assigned", "projectId": project.ID}, 200)
	for _, id := range []string{project.ID, "01ARZ3NDEKTSV4RRFFQ69G5FAV", ""} {
		body := call[struct {
			Code   string              `json:"error"`
			Issues []domain.FieldError `json:"issues"`
		}](h, "viewer", "POST", "/issues", map[string]any{"title": "Invalid", "type": "task", "projectId": id}, 400)
		require.Equal(t, "invalid", body.Code)
		require.Len(t, body.Issues, 1)
		require.Equal(t, "projectId", body.Issues[0].Path)
	}
	issue = call[domain.Issue](h, "viewer", "PATCH", "/issues/"+issue.ID, map[string]any{"projectId": nil}, 200)
	require.Nil(t, issue.ProjectID)
	call[any](h, "viewer", "PATCH", "/issues/"+issue.ID, map[string]string{"projectId": project.ID}, 400)
	timeline := call[items[domain.TimelineItem]](h, "viewer", "GET", "/issues/"+issue.ID+"/timeline", nil, 200)
	var changes []domain.Activity
	for _, item := range timeline.Items {
		if item.Activity != nil && item.Activity.Field == "project" {
			changes = append(changes, *item.Activity)
		}
	}
	require.Len(t, changes, 1)
	require.Equal(t, project.ID, changes[0].From)
	require.Nil(t, changes[0].To)
	got = call[domain.Project](h, "admin", "PATCH", "/projects/"+project.ID, map[string]bool{"archived": false}, 200)
	require.False(t, got.Archived)
	call[any](h, "admin", "DELETE", "/projects/"+project.ID, nil, 204)
	call[any](h, "viewer", "GET", "/projects/"+project.ID, nil, 404)
	call[any](h, "admin", "DELETE", "/projects/"+project.ID, nil, 404)
	call[any](h, "viewer", "PATCH", "/projects/"+project.ID, map[string]string{"name": "Missing"}, 404)
	page = call[store.Page](h, "viewer", "GET", "/issues?filter="+url.QueryEscape(`{"project":["none"]}`), nil, 200)
	require.Len(t, page.Items, 1)
	require.Nil(t, page.Items[0].ProjectID)
}

func TestProjectRequestValidation(t *testing.T) {
	h := newHarness(t)
	project := call[domain.Project](h, "viewer", "POST", "/projects", map[string]string{"name": "Valid"}, 201)
	for _, input := range []map[string]any{
		{"name": ""}, {"name": " "}, {"name": strings.Repeat("あ", 61)}, {"name": nil},
		{"description": strings.Repeat("あ", 1366)}, {"description": nil},
		{"color": "unknown"}, {"color": ""}, {"color": nil}, {"unknown": true},
	} {
		call[any](h, "viewer", "PATCH", "/projects/"+project.ID, input, 400)
		if _, present := input["name"]; !present {
			input["name"] = "Create invalid"
		}
		call[any](h, "viewer", "POST", "/projects", input, 400)
	}
	call[any](h, "admin", "PATCH", "/projects/"+project.ID, map[string]any{"archived": nil}, 400)
	call[any](h, "viewer", "POST", "/projects", map[string]any{"name": "Cannot archive on create", "archived": true}, 400)
	for _, query := range []string{"includeArchived=bad", "includeArchived=", "includeArchived=1"} {
		call[any](h, "viewer", "GET", "/projects?"+query, nil, 400)
	}
	for _, filter := range []string{`{"project":["me"]}`, `{"project":[""]}`, `{"project":"none"}`} {
		call[any](h, "viewer", "GET", "/issues?filter="+url.QueryEscape(filter), nil, 400)
	}
}

func TestProjectFieldErrorEnvelope(t *testing.T) {
	w := httptest.NewRecorder()
	writeStoreError(w, &domain.FieldError{Path: "projectId", Message: "Invalid project"})
	require.Equal(t, 400, w.Code)
	require.JSONEq(t, `{"error":"invalid","message":"Invalid project","issues":[{"path":"projectId","message":"Invalid project"}]}`, w.Body.String())
}

func TestOpenAPIProjectContract(t *testing.T) {
	var document struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			} `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &document))
	for path, methods := range map[string][]string{"/projects": {"get", "post"}, "/projects/{id}": {"get", "patch", "delete"}} {
		for _, method := range methods {
			require.Contains(t, document.Paths[path], method)
		}
	}
	for _, name := range []string{"Issue", "IssueSummary", "IssueCreate", "IssuePatch"} {
		require.Contains(t, document.Components.Schemas[name].Properties, "projectId")
	}
	for _, name := range []string{"Issue", "IssueSummary"} {
		require.Contains(t, document.Components.Schemas[name].Required, "projectId")
	}
	require.Contains(t, document.Components.Schemas["Filter"].Properties, "project")
	require.Contains(t, string(document.Components.Schemas["Activity"].Properties["field"]), `"project"`)
	for _, name := range []string{"Project", "ProjectCreate", "ProjectPatch"} {
		require.Contains(t, document.Components.Schemas, name)
	}
}
