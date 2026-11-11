package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestSprintRoutesRequireAuthentication(t *testing.T) {
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	handler := New(nil, auth, nil, nil, "test")
	for _, route := range []string{"GET /sprints", "POST /sprints", "GET /sprints/id", "PATCH /sprints/id", "DELETE /sprints/id", "POST /sprints/id/start", "POST /sprints/id/close", "GET /sprints/id/burndown", "GET /velocity"} {
		method, path, _ := strings.Cut(route, " ")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(method, "/api/tracker/v1"+path, nil))
		require.Equal(t, 401, w.Code, route)
	}
}
func TestSprintRequestValidationWithoutDatabase(t *testing.T) {
	a := &API{}
	for _, tc := range []struct {
		name, body string
		handler    endpoint
	}{
		{"unknown", `{"extra":true}`, a.sprintCreate}, {"null name", `{"name":null}`, a.sprintCreate}, {"numeric date", `{"startsOn":3}`, a.sprintCreate}, {"string weeks", `{"lengthWeeks":"2"}`, a.sprintPatch},
		{"missing close destination", `{}`, a.sprintClose}, {"bad close type", `{"moveIncompleteTo":3}`, a.sprintClose},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			_, _, err := tc.handler(&request{r: r, w: w})
			require.Error(t, err)
			writeStoreError(w, err)
			require.Equal(t, 400, w.Code)
		})
	}
	for _, limit := range []string{"0", "27", "x", ""} {
		r := httptest.NewRequest("GET", "/?limit="+limit, nil)
		w := httptest.NewRecorder()
		_, _, err := a.velocity(&request{r: r, w: w})
		require.Error(t, err)
		writeStoreError(w, err)
		require.Equal(t, 400, w.Code)
	}
}
func TestOpenAPISprintContract(t *testing.T) {
	var doc struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
				Enum       []string                   `json:"enum"`
			} `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &doc))
	s := doc.Components.Schemas
	for _, name := range []string{"Sprint", "SprintRef", "Tally", "Burndown", "BurndownPoint", "Velocity", "VelocityEntry", "SprintCreate", "SprintPatch", "SprintClose"} {
		require.Contains(t, s, name)
	}
	require.Equal(t, []string{"XS", "S", "M", "L", "XL"}, s["Size"].Enum)
	for _, name := range []string{"Issue", "IssueSummary"} {
		require.Contains(t, s[name].Required, "estimate")
		require.Contains(t, s[name].Required, "sprint")
	}
	for _, name := range []string{"IssueCreate", "IssuePatch"} {
		require.Contains(t, s[name].Properties, "estimate")
		require.Contains(t, s[name].Properties, "sprintId")
	}
	require.ElementsMatch(t, []string{"day", "ideal"}, s["BurndownPoint"].Required)
	require.Contains(t, s["Workspace"].Required, "timezone")
	require.Contains(t, s["Workspace"].Required, "sprintLengthWeeks")
	require.Contains(t, s["Sort"].Enum, "estimate")
	require.Contains(t, s["Activity"].Properties, "field")
}
func TestSprintHTTPFlow(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	h.database.Now = func() time.Time { return now }
	call[any](h, "viewer", "PATCH", "/workspace", map[string]any{"sprintLengthWeeks": 2}, 403)
	for _, body := range []map[string]any{{"sprintLengthWeeks": 3}, {"timezone": "Invalid/Zone"}, {"timezone": ""}, {"timezone": "Local"}} {
		call[any](h, "admin", "PATCH", "/workspace", body, 400)
	}
	workspace := call[domain.Workspace](h, "admin", "PATCH", "/workspace", map[string]any{"sprintLengthWeeks": 2, "timezone": "Asia/Tokyo"}, 200)
	require.Equal(t, 2, workspace.SprintLengthWeeks)
	list := call[items[domain.Sprint]](h, "viewer", "GET", "/sprints", nil, 200)
	require.Empty(t, list.Items)
	require.NotNil(t, list.Items)
	velocity := call[domain.Velocity](h, "viewer", "GET", "/velocity", nil, 200)
	require.Nil(t, velocity.AveragePerWeek)
	require.NotNil(t, velocity.Items)
	s := call[domain.Sprint](h, "viewer", "POST", "/sprints", map[string]any{"startsOn": "2026-11-02", "lengthWeeks": 1, "goal": "Ship charts"}, 201)
	require.Equal(t, "Sprint 1", s.Name)
	require.Equal(t, "2026-11-08", s.EndsOn)
	require.Nil(t, s.Commitment)
	s = call[domain.Sprint](h, "viewer", "PATCH", "/sprints/"+s.ID, map[string]any{"name": "Iteration", "goal": "A goal"}, 200)
	next := call[domain.Sprint](h, "viewer", "POST", "/sprints", map[string]any{}, 201)
	require.Equal(t, "2026-11-09", next.StartsOn)
	require.Equal(t, 2, next.LengthWeeks)
	call[any](h, "viewer", "POST", "/sprints", map[string]any{"startsOn": "2026-11-08"}, 409)
	call[any](h, "viewer", "POST", "/sprints/"+s.ID+"/close", map[string]any{"moveIncompleteTo": nil}, 409)
	a := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]any{"title": "Sized", "type": "task", "estimate": "M", "sprintId": s.ID}, 201)
	b := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]any{"title": "Unfinished", "type": "task", "estimate": "L", "sprintId": s.ID}, 201)
	now = now.Add(time.Minute)
	s = call[domain.Sprint](h, "viewer", "POST", "/sprints/"+s.ID+"/start", nil, 200)
	require.Equal(t, 8, s.Commitment.ScopePoints)
	call[any](h, "viewer", "POST", "/sprints/"+s.ID+"/start", nil, 409)
	call[any](h, "viewer", "POST", "/sprints/"+next.ID+"/start", nil, 409)
	call[any](h, "viewer", "PATCH", "/sprints/"+s.ID, map[string]any{"lengthWeeks": 2}, 409)
	call[any](h, "admin", "DELETE", "/sprints/"+s.ID, nil, 409)
	for _, target := range []string{s.ID, "01ARZ3NDEKTSV4RRFFQ69G5FAV", ""} {
		call[any](h, "viewer", "POST", "/sprints/"+s.ID+"/close", map[string]any{"moveIncompleteTo": target}, 400)
	}
	before := call[domain.BurndownResponse](h, "viewer", "GET", "/sprints/"+s.ID+"/burndown", nil, 200)
	require.Equal(t, 8, *before.Points[0].Remaining)
	statuses := call[items[domain.Status]](h, "viewer", "GET", "/statuses", nil, 200)
	var done string
	for _, status := range statuses.Items {
		if status.Category == "completed" {
			done = status.ID
		}
	}
	now = now.Add(time.Hour)
	call[domain.Issue](h, "viewer", "PATCH", "/issues/"+a.ID, map[string]any{"statusId": done}, 200)
	chart := call[domain.BurndownResponse](h, "viewer", "GET", "/sprints/"+s.ID+"/burndown?unit=points", nil, 200)
	require.Equal(t, 5, *chart.Points[0].Remaining)
	require.Nil(t, chart.Points[1].Scope)
	now = now.Add(time.Hour)
	s = call[domain.Sprint](h, "viewer", "POST", "/sprints/"+s.ID+"/close", map[string]any{"moveIncompleteTo": next.ID}, 200)
	require.Equal(t, "closed", s.State)
	require.Equal(t, 3, s.Current.DonePoints)
	b = call[domain.Issue](h, "viewer", "GET", "/issues/"+b.ID, nil, 200)
	require.Equal(t, next.ID, b.Sprint.ID)
	a = call[domain.Issue](h, "viewer", "GET", "/issues/"+a.ID, nil, 200)
	require.Equal(t, s.ID, a.Sprint.ID)
	call[any](h, "viewer", "PATCH", "/issues/"+a.ID, map[string]any{"sprintId": nil}, 400)
	call[any](h, "viewer", "PATCH", "/issues/"+a.ID, map[string]any{"sprintId": s.ID}, 400)
	velocity = call[domain.Velocity](h, "viewer", "GET", "/velocity?unit=points&limit=1", nil, 200)
	require.Len(t, velocity.Items, 1)
	require.Equal(t, 3.0, *velocity.AveragePerWeek)
	got := call[domain.Sprint](h, "viewer", "GET", "/sprints/"+s.ID, nil, 200)
	require.Equal(t, s, got)
	call[any](h, "viewer", "DELETE", "/sprints/"+next.ID, nil, 403)
	call[any](h, "admin", "DELETE", "/sprints/"+next.ID, nil, 204)
	b = call[domain.Issue](h, "viewer", "GET", "/issues/"+b.ID, nil, 200)
	require.Nil(t, b.Sprint)
	call[any](h, "viewer", "GET", "/sprints/"+next.ID, nil, 404)
	for name, v := range map[string]any{"Sprint": s, "Burndown": chart, "Velocity": velocity} {
		data, err := json.Marshal(v)
		require.NoError(t, err)
		t.Logf("%s JSON: %s", name, data)
	}
}
func TestSprintHTTPValidation(t *testing.T) {
	h := newHarness(t)
	for _, body := range []map[string]any{{"name": ""}, {"goal": strings.Repeat("a", 4097)}, {"lengthWeeks": 0}, {"lengthWeeks": 3}, {"startsOn": "2026-02-30"}} {
		call[any](h, "viewer", "POST", "/sprints", body, 400)
	}
	for _, path := range []string{"/sprints?state=bad", "/velocity?unit=bad", "/velocity?project=bad", "/velocity?limit=0", "/velocity?limit=27"} {
		call[any](h, "viewer", "GET", path, nil, 400)
	}
	s := call[domain.Sprint](h, "viewer", "POST", "/sprints", map[string]any{}, 201)
	call[any](h, "viewer", "GET", "/sprints/"+s.ID+"/burndown?unit=bad", nil, 400)
	call[any](h, "viewer", "GET", "/sprints/"+s.ID+"/burndown?project=bad", nil, 400)
	for _, body := range []map[string]any{{"estimate": "XXL"}, {"estimate": 3}, {"sprintId": "missing"}, {"type": "epic", "estimate": "M"}, {"type": "epic", "sprintId": s.ID}} {
		body["title"] = "Invalid"
		if _, ok := body["type"]; !ok {
			body["type"] = "task"
		}
		call[any](h, "viewer", "POST", "/issues", body, 400)
	}
	issue := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]any{"title": "Size", "type": "task", "estimate": "XS", "sprintId": s.ID}, 201)
	require.Equal(t, "XS", *issue.Estimate)
	issue = call[domain.Issue](h, "viewer", "PATCH", "/issues/"+issue.ID, map[string]any{"estimate": nil, "sprintId": nil}, 200)
	require.Nil(t, issue.Estimate)
	require.Nil(t, issue.Sprint)
	timeline := call[items[domain.TimelineItem]](h, "viewer", "GET", "/issues/"+issue.ID+"/timeline", nil, 200)
	fields := map[string]bool{}
	for _, item := range timeline.Items {
		if item.Activity != nil {
			fields[item.Activity.Field] = true
		}
	}
	require.True(t, fields["estimate"])
	require.True(t, fields["sprint"])
	view := call[domain.View](h, "viewer", "POST", "/views", map[string]any{"name": "Sprint", "groupBy": "sprint", "sort": "estimate", "filter": domain.Filter{Sprint: []string{"active", "none", s.ID}}}, 201)
	require.Equal(t, "sprint", view.GroupBy)
	require.Equal(t, domain.SortEstimate, view.Sort)
}
