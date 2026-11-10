package api

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestReporterFilterRequestsAndViews(t *testing.T) {
	h := newHarness(t)
	views := call[items[domain.View]](h, "viewer", "GET", "/views", nil, 200)
	require.Empty(t, views.Items)
	mine := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]string{"title": "Mine", "type": "task", "assigneeSub": "other"}, 201)
	other := call[domain.Issue](h, "other", "POST", "/issues", map[string]string{"title": "Other", "type": "task", "assigneeSub": "viewer"}, 201)
	for _, tc := range []struct {
		subject string
		filter  string
		id      string
	}{
		{"viewer", `{"reporter":["me"]}`, mine.ID},
		{"other", `{"reporter":["me"]}`, other.ID},
		{"viewer", `{"reporter":["other"]}`, other.ID},
	} {
		page := call[store.Page](h, tc.subject, "GET", "/issues?filter="+url.QueryEscape(tc.filter), nil, 200)
		require.Len(t, page.Items, 1)
		require.Equal(t, tc.id, page.Items[0].ID)
	}
	views = call[items[domain.View]](h, "viewer", "GET", "/views", nil, 200)
	require.Empty(t, views.Items, "listing reported issues must not create a stored view")
	filter := domain.Filter{Reporter: []string{"me"}}
	view := call[domain.View](h, "viewer", "POST", "/views", map[string]any{"name": "Reported", "filter": filter, "sort": "created"}, 201)
	require.Equal(t, filter, view.Filter)
	filter.Reporter = []string{"other"}
	view = call[domain.View](h, "viewer", "PATCH", "/views/"+view.ID, map[string]any{"filter": filter}, 200)
	require.Equal(t, filter, view.Filter)
	views = call[items[domain.View]](h, "viewer", "GET", "/views", nil, 200)
	require.Len(t, views.Items, 1)
	require.Equal(t, view, views.Items[0])

	for _, tc := range []struct {
		name     string
		reporter []string
		message  string
	}{
		{"empty subject", []string{""}, "Filter values must contain 1 to 4096 characters"},
		{"blank subject", []string{" \t"}, "Filter values must contain 1 to 4096 characters"},
		{"long subject", []string{strings.Repeat("x", 4097)}, "Filter values must contain 1 to 4096 characters"},
		{"too many entries", strings.Fields(strings.Repeat("viewer ", 21)), "Reporter filter must contain at most 20 entries"},
		{"none", []string{"none"}, "Reporter filter does not support none"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			filter := domain.Filter{Reporter: tc.reporter}
			data, err := json.Marshal(filter)
			require.NoError(t, err)
			for _, request := range []struct {
				method string
				path   string
				body   any
			}{
				{"GET", "/issues?filter=" + url.QueryEscape(string(data)), nil},
				{"POST", "/views", map[string]any{"name": "Invalid", "filter": filter}},
				{"PATCH", "/views/" + view.ID, map[string]any{"filter": filter}},
			} {
				body := call[struct {
					Code    string              `json:"error"`
					Message string              `json:"message"`
					Issues  []domain.FieldError `json:"issues"`
				}](h, "viewer", request.method, request.path, request.body, 400)
				require.Equal(t, "invalid", body.Code)
				require.Equal(t, tc.message, body.Message)
				require.Equal(t, []domain.FieldError{{Path: "filter.reporter", Message: tc.message}}, body.Issues)
			}
		})
	}
	views = call[items[domain.View]](h, "viewer", "GET", "/views", nil, 200)
	require.Equal(t, []domain.View{view}, views.Items, "invalid filters must not change saved views")
}

func TestOpenAPIReporterFilterContract(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &document))
	reporter := document.Components.Schemas["Filter"].Properties["reporter"]
	require.NotEmpty(t, reporter)
	var schema struct {
		Type        string `json:"type"`
		Description string `json:"description"`
		MaxItems    int    `json:"maxItems"`
		Items       struct {
			Type      string `json:"type"`
			MinLength int    `json:"minLength"`
			MaxLength int    `json:"maxLength"`
			Not       struct {
				Const string `json:"const"`
			} `json:"not"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(reporter, &schema))
	require.Equal(t, "array", schema.Type)
	require.Equal(t, 20, schema.MaxItems)
	require.Equal(t, "string", schema.Items.Type)
	require.Equal(t, 1, schema.Items.MinLength)
	require.Equal(t, 4096, schema.Items.MaxLength)
	require.Equal(t, "none", schema.Items.Not.Const)
	require.Contains(t, schema.Description, "'me' resolves to the caller")
}
