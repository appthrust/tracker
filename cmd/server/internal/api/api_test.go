package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/directory"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

type harness struct {
	t      *testing.T
	server *httptest.Server
}

func token(subject string) string {
	claims, _ := json.Marshal(map[string]string{"sub": subject, "email": subject + "@example.test", "name": subject})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
}
func newHarness(t *testing.T) *harness {
	database, _ := testutil.Database(t, store.Open)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/projects/pj-test/access" {
			http.NotFound(w, r)
			return
		}
		role := "Viewer"
		if r.Header.Get("Authorization") == "Bearer "+token("admin") {
			role = "Admin"
		}
		httpx.WriteJSON(w, 200, map[string]any{"member": true, "roles": []string{role}, "actions": []string{}})
	}))
	t.Cleanup(upstream.Close)
	issuer := testutil.NewOIDCIssuer(t)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	require.NoError(t, err)
	_, _, err = auth.Authenticate(t.Context(), issuer.Bearer(t))
	require.NoError(t, err)
	auth, err = identity.New(identity.Trust{})
	require.NoError(t, err)
	server := httptest.NewServer(New(database, auth, platformclient.New(upstream.URL, "pj-test"), directory.New(nil, ""), "pj-test"))
	t.Cleanup(server.Close)
	return &harness{t: t, server: server}
}
func call[T any](h *harness, subject, method, path string, body any, status int) T {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(h.t, err)
		reader = bytes.NewReader(data)
	}
	r, err := http.NewRequest(method, h.server.URL+"/api/tracker/v1"+path, reader)
	require.NoError(h.t, err)
	if subject != "" {
		r.Header.Set("Authorization", "Bearer "+token(subject))
	}
	r.Header.Set("Content-Type", "application/json")
	response, err := h.server.Client().Do(r)
	require.NoError(h.t, err)
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	require.NoError(h.t, err)
	require.Equal(h.t, status, response.StatusCode, "%s %s: %s", method, path, data)
	var result T
	if status != 204 {
		require.NoError(h.t, json.Unmarshal(data, &result))
	}
	return result
}
func TestIssueLifecycleAndAuthorization(t *testing.T) {
	h := newHarness(t)
	call[any](h, "", "GET", "/openapi.json", nil, 200)
	call[any](h, "", "GET", "/workspace", nil, 401)
	me := call[meResponse](h, "admin", "GET", "/me", nil, 200)
	require.True(t, me.IsAdmin)
	workspace := call[domain.Workspace](h, "viewer", "GET", "/workspace", nil, 200)
	require.Equal(t, "APT", workspace.Key)
	call[any](h, "viewer", "PATCH", "/workspace", map[string]string{"key": "NEW"}, 403)
	call[any](h, "viewer", "POST", "/issues", map[string]string{"title": "Bug", "type": "bug"}, 400)
	issue := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]any{"title": "Bug", "type": "bug", "report": map[string]string{"environment": "local", "surface": "apth"}}, 201)
	require.Equal(t, "APT-1", issue.Identifier)
	require.NotNil(t, issue.LabelIDs)
	got := call[domain.Issue](h, "reader", "GET", "/issues/apt-1", nil, 200)
	require.Equal(t, issue.ID, got.ID)
	comment := call[domain.Comment](h, "viewer", "POST", "/issues/"+issue.ID+"/comments", map[string]string{"body": "Investigating"}, 201)
	call[any](h, "admin", "PATCH", "/comments/"+comment.ID, map[string]string{"body": "Other author"}, 403)
	call[domain.Comment](h, "viewer", "PATCH", "/comments/"+comment.ID, map[string]string{"body": "Edited"}, 200)
	statuses := call[items[domain.Status]](h, "reader", "GET", "/statuses", nil, 200)
	issue = call[domain.Issue](h, "reader", "PATCH", "/issues/"+issue.ID, map[string]string{"statusId": statuses.Items[4].ID}, 200)
	require.NotNil(t, issue.CompletedAt)
	timeline := call[items[domain.TimelineItem]](h, "reader", "GET", "/issues/"+issue.ID+"/timeline", nil, 200)
	require.Len(t, timeline.Items, 3)
	page := call[store.Page](h, "reader", "GET", "/issues?filter="+url.QueryEscape(`{"type":["bug"],"surface":["apth"]}`), nil, 200)
	require.Len(t, page.Items, 1)
	call[any](h, "viewer", "DELETE", "/issues/"+issue.ID, nil, 403)
	call[any](h, "admin", "DELETE", "/comments/"+comment.ID, nil, 204)
	call[any](h, "admin", "DELETE", "/issues/"+issue.ID, nil, 204)
	call[any](h, "reader", "GET", "/issues/"+issue.ID, nil, 404)
	people := call[peopleResponse](h, "reader", "GET", "/people", nil, 200)
	require.Equal(t, "unavailable", people.Source)
	require.Empty(t, people.Items)
}
func TestSettingsViewsAndValidation(t *testing.T) {
	h := newHarness(t)
	for _, route := range []string{"/statuses", "/labels"} {
		call[any](h, "viewer", "POST", route, map[string]string{"name": "No", "color": "red"}, 403)
	}
	status := call[domain.Status](h, "admin", "POST", "/statuses", map[string]string{"name": "Verify", "category": "started"}, 201)
	call[domain.Status](h, "admin", "PATCH", "/statuses/"+status.ID, map[string]string{"color": "blue"}, 200)
	list := call[items[domain.Status]](h, "reader", "GET", "/statuses", nil, 200)
	ids := []string{}
	for _, s := range list.Items {
		ids = append(ids, s.ID)
	}
	call[items[domain.Status]](h, "admin", "PUT", "/statuses/order", map[string]any{"ids": ids}, 200)
	ids[0], ids[len(ids)-1] = ids[len(ids)-1], ids[0]
	call[any](h, "admin", "PUT", "/statuses/order", map[string]any{"ids": ids}, 400)
	call[any](h, "admin", "DELETE", "/statuses/"+list.Items[0].ID, nil, 409)
	call[any](h, "admin", "DELETE", "/statuses/"+status.ID, nil, 204)
	label := call[domain.Label](h, "admin", "POST", "/labels", map[string]string{"name": "ux", "color": "purple"}, 201)
	call[domain.Label](h, "admin", "PATCH", "/labels/"+label.ID, map[string]string{"name": "design"}, 200)
	call[any](h, "admin", "DELETE", "/labels/"+label.ID, nil, 204)
	private := call[domain.View](h, "viewer", "POST", "/views", map[string]string{"name": "Mine"}, 201)
	call[any](h, "viewer", "POST", "/views", map[string]any{"name": "Shared", "shared": true}, 403)
	shared := call[domain.View](h, "admin", "POST", "/views", map[string]any{"name": "Bugs", "shared": true, "filter": map[string]any{"type": []string{"bug"}}}, 201)
	views := call[items[domain.View]](h, "other", "GET", "/views", nil, 200)
	require.Len(t, views.Items, 1)
	call[any](h, "admin", "DELETE", "/views/"+private.ID, nil, 403)
	call[any](h, "viewer", "PATCH", "/views/"+shared.ID, map[string]string{"name": "No"}, 403)
	call[domain.View](h, "viewer", "PATCH", "/views/"+private.ID, map[string]string{"layout": "board"}, 200)
	call[any](h, "viewer", "DELETE", "/views/"+private.ID, nil, 204)
	for _, path := range []string{"/issues?limit=0", "/issues?limit=201", "/issues?sort=bad", "/issues?cursor=bad", "/issues?filter=" + url.QueryEscape(`{"unknown":true}`)} {
		e := call[httpx.Error](h, "reader", "GET", path, nil, 400)
		require.Equal(t, "invalid", e.Code)
	}
	for _, input := range []map[string]any{{"title": "x", "type": "task", "unknown": true}, {"title": strings.Repeat("x", 201), "type": "task"}, {"title": "x", "type": "task", "report": map[string]string{"environment": "local", "surface": "apth"}}} {
		call[any](h, "reader", "POST", "/issues", input, 400)
	}
}
func TestAttachmentRoundTrip(t *testing.T) {
	h := newHarness(t)
	issue := call[domain.Issue](h, "viewer", "POST", "/issues", map[string]string{"title": "Upload", "type": "task"}, 201)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreatePart(textproto.MIMEHeader{"Content-Disposition": {`form-data; name="file"; filename="note.txt"`}, "Content-Type": {"text/plain"}})
	require.NoError(t, err)
	_, err = part.Write([]byte("Hello Tracker"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	r, err := http.NewRequest("POST", h.server.URL+"/api/tracker/v1/issues/"+issue.ID+"/attachments", &body)
	require.NoError(t, err)
	r.Header.Set("Authorization", "Bearer "+token("viewer"))
	r.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := h.server.Client().Do(r)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 201, response.StatusCode)
	var attachment domain.Attachment
	require.NoError(t, json.NewDecoder(response.Body).Decode(&attachment))
	require.Equal(t, "viewer", attachment.Uploader.Name)
	r, err = http.NewRequest("GET", h.server.URL+attachment.URL, nil)
	require.NoError(t, err)
	r.Header.Set("Authorization", "Bearer "+token("reader"))
	download, err := h.server.Client().Do(r)
	require.NoError(t, err)
	defer download.Body.Close()
	require.Equal(t, 200, download.StatusCode)
	data, err := io.ReadAll(download.Body)
	require.NoError(t, err)
	require.Equal(t, "Hello Tracker", string(data))
	require.Equal(t, "text/plain", download.Header.Get("Content-Type"))
	require.Equal(t, "private, max-age=31536000, immutable", download.Header.Get("Cache-Control"))
	call[any](h, "other", "DELETE", "/attachments/"+attachment.ID, nil, 403)
	call[any](h, "viewer", "DELETE", "/attachments/"+attachment.ID, nil, 204)
	call[any](h, "viewer", "GET", "/attachments/"+attachment.ID, nil, 404)
}
func TestOpenAPIRouteInventory(t *testing.T) {
	var document struct {
		OpenAPI string                    `json:"openapi"`
		Paths   map[string]map[string]any `json:"paths"`
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &document))
	require.Equal(t, "3.1.0", document.OpenAPI)
	for path, methods := range map[string][]string{"/me": {"get"}, "/workspace": {"get", "patch"}, "/statuses": {"get", "post"}, "/statuses/{id}": {"patch", "delete"}, "/statuses/order": {"put"}, "/labels": {"get", "post"}, "/labels/{id}": {"patch", "delete"}, "/issues": {"get", "post"}, "/issues/{id}": {"get", "patch", "delete"}, "/issues/{id}/timeline": {"get"}, "/issues/{id}/comments": {"post"}, "/comments/{id}": {"patch", "delete"}, "/issues/{id}/attachments": {"post"}, "/attachments/{id}": {"get", "delete"}, "/views": {"get", "post"}, "/views/{id}": {"patch", "delete"}, "/people": {"get"}, "/openapi.json": {"get"}} {
		for _, method := range methods {
			require.Contains(t, document.Paths[path], method, "%s %s", method, path)
		}
	}
	w := httptest.NewRecorder()
	Unavailable().ServeHTTP(w, httptest.NewRequest("GET", "/api/tracker/v1/openapi.json", nil))
	require.Equal(t, 200, w.Code)
}

func TestProjectionPreservesIndividualSnapshots(t *testing.T) {
	a := &API{directory: directory.New(nil, "")}
	s := &request{r: httptest.NewRequest("GET", "/", nil)}
	page := &store.Page{Items: []domain.IssueSummary{
		{Reporter: domain.Person{Sub: "same", Name: "Earlier snapshot"}},
		{Reporter: domain.Person{Sub: "same", Name: "Later snapshot"}},
	}}
	a.enrich(s, page)
	require.Equal(t, "Earlier snapshot", page.Items[0].Reporter.Name)
	require.Equal(t, "Later snapshot", page.Items[1].Reporter.Name)
}
