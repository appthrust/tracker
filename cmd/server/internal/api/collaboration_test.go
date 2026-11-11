package api

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func rawCall(t *testing.T, h *harness, bearer, method, path, key string, body []byte, status int) []byte {
	t.Helper()
	r, err := http.NewRequest(method, h.server.URL+"/api/tracker/v1"+path, bytes.NewReader(body))
	require.NoError(t, err)
	r.Header.Set("Authorization", bearer)
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	response, err := h.server.Client().Do(r)
	require.NoError(t, err)
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, status, response.StatusCode, string(data))
	return data
}

func TestPostIdempotencyReplaysStatusBodyAndExpires(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	h.database.Now = func() time.Time { return now }
	bearer := "Bearer " + token("admin")
	body := []byte(`{"title":"Exactly once","type":"task"}`)
	first := rawCall(t, h, bearer, "POST", "/issues", "create", body, 201)
	replayed := rawCall(t, h, bearer, "POST", "/issues", "create", body, 201)
	require.Equal(t, first, replayed, "response bytes are replayed, not reconstructed")
	var issue domain.Issue
	require.NoError(t, json.Unmarshal(first, &issue))
	conflict := rawCall(t, h, bearer, "POST", "/issues", "create", []byte(`{"title":"Different","type":"task"}`), 409)
	require.Contains(t, string(conflict), `"error":"conflict"`)
	rawCall(t, h, bearer, "POST", "/issues/"+issue.ID+"/comments", "create", body, 409)
	page := call[store.EventPage](h, "admin", "GET", "/events?after=0", nil, 200)
	require.Len(t, page.Items, 1)
	failure := rawCall(t, h, bearer, "POST", "/issues", "invalid", []byte(`{"type":"task"}`), 400)
	require.Equal(t, failure, rawCall(t, h, bearer, "POST", "/issues", "invalid", []byte(`{"type":"task"}`), 400))
	rawCall(t, h, bearer, "POST", "/inbox/ack", "ack", []byte(`{}`), 204)
	rawCall(t, h, bearer, "POST", "/inbox/ack", "ack", []byte(`{}`), 204)
	rawCall(t, h, bearer, "POST", "/issues", strings.Repeat("x", 129), body, 400)
	// Different actors do not share idempotency keys.
	rawCall(t, h, "Bearer "+token("other"), "POST", "/issues", "create", body, 201)
	now = now.Add(24 * time.Hour)
	after := rawCall(t, h, bearer, "POST", "/issues", "create", body, 201)
	require.NotEqual(t, first, after)
	require.NoError(t, h.database.InWorkspace(t.Context(), "pj-test", false, func(tx *store.Tx) error {
		var count int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM tracker_idempotency WHERE workspace_id=$1`, "pj-test").Scan(&count))
		require.Equal(t, 1, count, "the next insert deletes expired rows opportunistically")
		return nil
	}))
}

func TestExpectedUpdateAndMentionsOnCreateEditAck(t *testing.T) {
	h := newHarness(t)
	agent := call[domain.Agent](h, "admin", "POST", "/agents", map[string]string{"handle": "astra", "name": "Astra", "ownerSub": "admin"}, 201)
	issue := call[domain.Issue](h, "admin", "POST", "/issues", map[string]string{"title": "Versioned", "type": "task"}, 201)
	changed := call[domain.Issue](h, "admin", "PATCH", "/issues/"+issue.ID, map[string]any{"title": "Changed", "expectedUpdatedAt": issue.UpdatedAt}, 200)
	require.NotEqual(t, issue.UpdatedAt, changed.UpdatedAt)
	call[any](h, "admin", "PATCH", "/issues/"+issue.ID, map[string]any{"title": "Stale", "expectedUpdatedAt": issue.UpdatedAt}, 409)
	comment := call[domain.Comment](h, "admin", "POST", "/issues/"+issue.ID+"/comments", map[string]string{"body": "@astra @astra and mail@astra.test"}, 201)
	require.Len(t, comment.Mentions, 1)
	require.Equal(t, agent.ID, comment.Mentions[0].Agent.ID)
	require.NoError(t, h.database.InWorkspace(t.Context(), "pj-test", true, func(tx *store.Tx) error {
		actor, err := tx.AgentBySubject("astra")
		require.NoError(t, err)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		require.Len(t, inbox, 1)
		require.Equal(t, "mention", inbox[0].Kind)
		require.NoError(t, tx.AckInbox(store.InboxAck{Mentions: []string{comment.ID}}, domain.Actor{Person: domain.Person{Sub: "other"}}))
		inbox, err = tx.Inbox(actor)
		require.NoError(t, err)
		require.Len(t, inbox, 1)
		require.NoError(t, tx.AckInbox(store.InboxAck{Mentions: []string{comment.ID}}, actor))
		_, err = tx.PatchComment(comment.ID, "Still @astra", domain.Actor{Person: domain.Person{Sub: "admin"}})
		require.NoError(t, err)
		inbox, err = tx.Inbox(actor)
		require.NoError(t, err)
		require.Empty(t, inbox, "editing a retained mention preserves acknowledgement")
		_, err = tx.PatchComment(comment.ID, "No mention", domain.Actor{Person: domain.Person{Sub: "admin"}})
		require.NoError(t, err)
		c, err := tx.Comment(comment.ID)
		require.NoError(t, err)
		require.Empty(t, c.Mentions)
		_, err = tx.PatchComment(comment.ID, "Again @astra", domain.Actor{Person: domain.Person{Sub: "admin"}})
		require.NoError(t, err)
		inbox, err = tx.Inbox(actor)
		require.NoError(t, err)
		require.Len(t, inbox, 1)
		return nil
	}))
}

func TestExternalAgentRoutesAndLastSeen(t *testing.T) {
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	signer := accesskey.NewES256Signer("agent-test", private)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(signer.JWKS()) }))
	t.Cleanup(jwks.Close)
	issuer := accesskey.IssuerURL(jwks.URL)
	h := newHarnessTrusting(t, identity.Trust{AccessIssuer: issuer, AccessAudience: "tracker"})
	now := time.Now().UTC().Truncate(time.Microsecond)
	h.database.Now = func() time.Time { return now }
	assertion := func(scopes ...string) string {
		value, err := signer.Sign(accesskey.Claims{Issuer: issuer, Audience: "tracker", Project: "pj-test", KeyName: "ak-agent", Subject: accesskey.Subject{Kind: accesskey.SubjectExternal, ID: "astra"}, Scopes: scopes, JTI: "test", IssuedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute)})
		require.NoError(t, err)
		return "Bearer " + value
	}
	bearer := assertion(scopeRead, scopeWrite)
	rawCall(t, h, bearer, "GET", "/me", "", nil, 403)
	agent := call[domain.Agent](h, "admin", "POST", "/agents", map[string]string{"handle": "astra", "name": "Astra", "ownerSub": "admin"}, 201)
	for _, input := range []map[string]any{{"handle": "renamed"}, {"keySubject": "old"}, {"name": nil}} {
		call[any](h, "admin", "PATCH", "/agents/"+agent.ID, input, 400)
	}
	me := rawCall(t, h, bearer, "GET", "/me", "", nil, 200)
	require.Contains(t, string(me), `"kind":"agent"`)
	require.Contains(t, string(me), `"scopes":["tracker:read","tracker:write"]`)
	first := call[items[domain.Agent]](h, "admin", "GET", "/agents", nil, 200).Items[0]
	require.Equal(t, now, *first.LastSeenAt)
	now = now.Add(30 * time.Second)
	rawCall(t, h, bearer, "GET", "/me", "", nil, 200)
	second := call[items[domain.Agent]](h, "admin", "GET", "/agents", nil, 200).Items[0]
	require.Equal(t, first.LastSeenAt, second.LastSeenAt)
	now = now.Add(30 * time.Second)
	rawCall(t, h, bearer, "GET", "/me", "", nil, 200)
	third := call[items[domain.Agent]](h, "admin", "GET", "/agents", nil, 200).Items[0]
	require.Equal(t, now, *third.LastSeenAt)
	missing := rawCall(t, h, assertion(scopeRead), "POST", "/issues", "", []byte(`{"title":"No scope","type":"task"}`), 403)
	require.Contains(t, string(missing), `"error":"insufficient_scope"`)
	unrelated := call[domain.Issue](h, "admin", "POST", "/issues", map[string]string{"title": "Unrelated", "type": "task"}, 201)
	rawCall(t, h, bearer, "PATCH", "/issues/"+unrelated.ID, "", []byte(`{"title":"Denied"}`), 403)
	rawCall(t, h, bearer, "POST", "/issues/"+unrelated.ID+"/comments", "", []byte(`{"body":"Allowed discussion"}`), 201)
	for _, to := range []string{``, `,"to":null`} {
		data := rawCall(t, h, bearer, "POST", "/issues/"+unrelated.ID+"/requests", "", []byte(`{"kind":"question","title":"Question"`+to+`}`), 201)
		var q domain.Request
		require.NoError(t, json.Unmarshal(data, &q))
		if to == "" {
			require.Equal(t, "admin", q.To.Sub)
		} else {
			require.Nil(t, q.To)
		}
	}
	for _, route := range []struct{ method, path, body string }{
		{"PATCH", "/workspace", `{"agentCompletion":"direct"}`},
		{"POST", "/agents", `{}`}, {"POST", "/statuses", `{}`}, {"POST", "/labels", `{}`},
		{"DELETE", "/issues/" + unrelated.ID, ``},
	} {
		rawCall(t, h, bearer, route.method, route.path, "", []byte(route.body), 403)
	}
	call[domain.Agent](h, "admin", "PATCH", "/agents/"+agent.ID, map[string]bool{"disabled": true}, 200)
	rawCall(t, h, bearer, "GET", "/me", "", nil, 403)
}

func TestAgentGuideAndOpenAPIShapes(t *testing.T) {
	guide, status, err := (&API{}).agentGuide(nil)
	require.NoError(t, err)
	require.Equal(t, 200, status)
	for _, route := range (&API{}).routes() {
		if route.guide != "" {
			require.Contains(t, string(guide.(markdown)), route.pattern)
		}
	}
	var document struct {
		Components struct{ Schemas map[string]map[string]any }
		Paths      map[string]map[string]map[string]any
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &document))
	for _, name := range []string{"Actor", "Agent", "Run", "Request", "InboxItem", "Event", "EventPage", "InboxAck", "RunFinish", "RequestCreate"} {
		require.Contains(t, document.Components.Schemas, name)
	}
	for path, methods := range document.Paths {
		if operation, ok := methods["post"]; ok && !strings.HasSuffix(path, "/attachments") {
			parameters, err := json.Marshal(operation["parameters"])
			require.NoError(t, err)
			require.Contains(t, string(parameters), "Idempotency-Key", path)
		}
	}
}

func TestFinishRequiresSummaryBeforeStoreAccess(t *testing.T) {
	for _, body := range []string{`{"outcome":"succeeded"}`, `{"outcome":"failed","summary":null}`} {
		r := httptest.NewRequest("POST", "/runs/example/finish", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		_, _, err := (&API{}).runFinish(&request{r: r, w: httptest.NewRecorder()})
		require.Error(t, err)
	}
}
