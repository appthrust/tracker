package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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

func TestExternalKeyPreservesProjectScopeAndViewerBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, project, subject string
		scopes                 []string
		mutation               bool
		code                   int
	}{
		{"external", "pj", "external:poc-astra", []string{scopeRead}, false, 200},
		{"user", "pj", "user:pat", []string{scopeWrite}, true, 200},
		{"project", "other", "external:poc-astra", []string{scopeRead}, false, 401},
		{"scope", "pj", "external:poc-astra", []string{scopeRead}, true, 403},
		{"component", "pj", "component:web", []string{scopeRead}, false, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor, err := keyActor(accesskey.Principal{Project: tc.project, Subject: tc.subject, Scopes: tc.scopes}, "pj", tc.mutation)
			if tc.code == 200 {
				require.NoError(t, err)
				require.Equal(t, "Viewer", actor.Role)
				require.True(t, actor.Key)
				require.False(t, domain.Can(actor, domain.ManageWorkspace, domain.Target{}))
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestAgentLeaseWaitingAndDisabledBoundaries(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	h.database.Now = func() time.Time { return now }
	h.database.RunLease = time.Minute
	a := call[domain.Agent](h, "admin", "POST", "/agents", store.AgentCreate{Handle: "astra", Name: "Astra", OwnerSub: "owner"}, 201)
	sub := "agent:" + a.ID
	statuses := call[items[domain.Status]](h, "admin", "GET", "/statuses", nil, 200)
	unstarted := ""
	for _, status := range statuses.Items {
		if status.Category == "unstarted" {
			unstarted = status.ID
			break
		}
	}
	assigned := call[domain.Issue](h, "admin", "POST", "/issues", map[string]string{"title": "Delegated", "type": "task", "assigneeSub": sub, "statusId": unstarted}, 201)
	require.Equal(t, "admin", assigned.Delegator.Sub)
	person := domain.Actor{Person: domain.Person{Sub: "admin", Name: "admin"}, Kind: "person", Role: "Admin"}
	var run domain.Run
	var first, second domain.Request
	write := func(fn func(*store.Tx) error) {
		require.NoError(t, h.database.InWorkspace(t.Context(), "pj-test", true, fn))
	}
	write(func(tx *store.Tx) error {
		actor, err := tx.AgentBySubject("astra")
		require.NoError(t, err)
		run, err = tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		input := store.RequestCreate{Kind: "question", Title: "Decision?", RunID: &run.ID}
		first, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		second, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		_, err = tx.AnswerRequest(first.ID, store.RequestAnswer{Body: "First"}, person)
		require.NoError(t, err)
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "waiting", current.State, "one open request still holds the run")
		_, err = tx.AnswerRequest(second.ID, store.RequestAnswer{Body: "Second"}, person)
		require.NoError(t, err)
		current, err = tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "running", current.State)
		first, err = tx.CreateRequest(assigned.ID, input, actor, nil)
		require.NoError(t, err)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		for _, item := range inbox {
			require.NotEqual(t, "assignment", item.Kind, "waiting on a live request is not actionable")
		}
		return nil
	})
	now = now.Add(time.Minute)
	write(func(tx *store.Tx) error {
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "waiting", current.State, "lease equality is still live")
		return nil
	})
	now = now.Add(time.Microsecond)
	write(func(tx *store.Tx) error {
		actor, err := tx.AgentBySubject("astra")
		require.NoError(t, err)
		current, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "stalled", current.State)
		inbox, err := tx.Inbox(actor)
		require.NoError(t, err)
		assignments := 0
		for _, item := range inbox {
			if item.Kind == "assignment" && item.Issue.ID == assigned.ID {
				assignments++
			}
		}
		require.Equal(t, 1, assignments, "an expired run and its pending request must not hide recovery work")
		_, err = tx.HeartbeatRun(run.ID, nil, actor)
		require.ErrorContains(t, err, "lease has expired")
		_, err = tx.FinishRun(run.ID, store.RunFinish{Outcome: "succeeded"}, actor)
		require.ErrorContains(t, err, "lease has expired")
		next, err := tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		old, err := tx.Run(run.ID)
		require.NoError(t, err)
		require.Equal(t, "failed", old.State)
		require.Equal(t, "lease_expired", *old.Reason)
		_, err = tx.CancelRun(next.ID, person)
		require.NoError(t, err)
		next, err = tx.StartRun(assigned.ID, store.RunStart{}, actor)
		require.NoError(t, err)
		pending, err := tx.CreateRequest(assigned.ID, store.RequestCreate{Kind: "question", Title: "Before reassignment", RunID: &next.ID}, actor, nil)
		require.NoError(t, err)
		_, err = tx.PatchIssue(assigned.ID, store.IssuePatch{AssigneeSub: store.Field[string]{Present: true}}, person.Person, nil)
		require.NoError(t, err)
		canceled, err := tx.Run(next.ID)
		require.NoError(t, err)
		require.Equal(t, "canceled", canceled.State)
		require.Equal(t, "reassigned", *canceled.Reason)
		withdrawn, err := tx.Request(pending.ID)
		require.NoError(t, err)
		require.Equal(t, "withdrawn", withdrawn.State)
		return nil
	})
	cleared := call[domain.Issue](h, "admin", "PATCH", "/issues/"+assigned.ID, map[string]any{"assigneeSub": nil}, 200)
	require.Nil(t, cleared.Delegator)
	write(func(tx *store.Tx) error { return tx.Exec(`UPDATE tracker_agent SET disabled=true WHERE id=$1`, a.ID) })
	write(func(tx *store.Tx) error {
		_, err := tx.AgentBySubject("astra")
		require.ErrorContains(t, err, "active registered agent")
		return nil
	})
	for _, target := range []string{sub, "agent:unknown"} {
		response := call[map[string]any](h, "admin", "PATCH", "/issues/"+assigned.ID, map[string]string{"assigneeSub": target}, 400)
		issues := response["issues"].([]any)
		require.Equal(t, "assigneeSub", issues[0].(map[string]any)["path"])
	}
}

func TestAgentSelfRegistration(t *testing.T) {
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	signer := accesskey.NewES256Signer("registration-test", private)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/access/jwks.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(signer.JWKS())
	}))
	t.Cleanup(jwks.Close)
	issuer := accesskey.IssuerURL(jwks.URL)
	h := newHarnessTrusting(t, identity.Trust{AccessIssuer: issuer, AccessAudience: "tracker"})
	assertion := func(subject accesskey.Subject, keyName string, scopes ...string) string {
		value, err := signer.Sign(accesskey.Claims{
			Issuer: issuer, Audience: "tracker", Project: "pj-test", KeyName: keyName, Subject: subject,
			Scopes: scopes, JTI: "test", IssuedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute),
		})
		require.NoError(t, err)
		return "Bearer " + value
	}
	external := func(handle string, scopes ...string) string {
		return assertion(accesskey.Subject{Kind: accesskey.SubjectExternal, ID: handle}, "ak-register", scopes...)
	}
	bearer := external("self-agent", scopeRead, scopeWrite)
	body := []byte(`{"name":"Self Agent","description":"Registers itself","ownerSub":"owner"}`)
	checkBlockedRoutes := func(t *testing.T) {
		t.Helper()
		for _, route := range (&API{}).routes() {
			if route.pattern == "POST /agents/register" || route.pattern == "GET /agent-guide" {
				continue
			}
			method, path, _ := strings.Cut(route.pattern, " ")
			path = strings.ReplaceAll(path, "{id}", "01JABCDEFGHJKMNPQRSTVWXYZ0")
			data := rawCall(t, h, bearer, method, path, "", []byte(`{}`), 403)
			require.Contains(t, string(data), `"error":"key_subject"`, route.pattern)
		}
		data := rawCall(t, h, bearer, "GET", "/people/person-1/avatar", "", nil, 403)
		require.Contains(t, string(data), `"error":"key_subject"`)
		guide := rawCall(t, h, bearer, "GET", "/agent-guide", "", nil, 200)
		require.Contains(t, string(guide), "POST /agents/register")
	}
	t.Run("unregistered routes", checkBlockedRoutes)
	data := rawCall(t, h, bearer, "GET", "/me", "", nil, 403)
	require.Contains(t, string(data), "POST /api/tracker/v1/agents/register")

	// Reads and user-key writes cannot supply the owner's signed-in name.
	rawCall(t, h, "Bearer "+token("read-owner"), "GET", "/me", "", nil, 200)
	userKey := assertion(accesskey.Subject{Kind: accesskey.SubjectUser, ID: "key-owner"}, "ak-user", scopeRead, scopeWrite)
	rawCall(t, h, userKey, "POST", "/issues", "", []byte(`{"title":"Only a key wrote","type":"task"}`), 201)
	for _, owner := range []string{"unknown-owner", "read-owner", "key-owner", "agent:01JABCDEFGHJKMNPQRSTVWXYZ0", ""} {
		t.Run("invalid owner "+owner, func(t *testing.T) {
			input, err := json.Marshal(map[string]string{"name": "Self Agent", "ownerSub": owner})
			require.NoError(t, err)
			data := rawCall(t, h, bearer, "POST", "/agents/register", "", input, 400)
			var failure struct {
				Code   string              `json:"error"`
				Issues []domain.FieldError `json:"issues"`
			}
			require.NoError(t, json.Unmarshal(data, &failure))
			require.Equal(t, "invalid", failure.Code)
			require.Len(t, failure.Issues, 1)
			require.Equal(t, "ownerSub", failure.Issues[0].Path)
		})
	}
	for _, tc := range []struct {
		name, bearer, code string
		status             int
	}{
		{"user key", userKey, "forbidden", 403},
		{"signed-in admin", "Bearer " + token("admin"), "forbidden", 403},
		{"signed-in person", "Bearer " + token("owner"), "forbidden", 403},
		{"read-only external key", external("self-agent", scopeRead), "insufficient_scope", 403},
		{"invalid handle", external("Invalid_handle", scopeWrite), "invalid", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := rawCall(t, h, tc.bearer, "POST", "/agents/register", "", body, tc.status)
			require.Contains(t, string(data), `"error":"`+tc.code+`"`)
		})
	}
	claims, err := json.Marshal(map[string]string{"sub": "owner", "name": "Olivia Owner", "email": "owner@example.test"})
	require.NoError(t, err)
	session := "Bearer " + base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
	rawCall(t, h, session, "POST", "/issues", "", []byte(`{"title":"Signed-in owner","type":"task"}`), 201)
	for _, tc := range []struct {
		name, body string
	}{
		{"empty name", `{"name":"","ownerSub":"owner"}`},
		{"blank name", `{"name":"   ","ownerSub":"owner"}`},
		{"long name", `{"name":"` + strings.Repeat("あ", 201) + `","ownerSub":"owner"}`},
		{"long description", `{"name":"Agent","description":"` + strings.Repeat("é", 2049) + `","ownerSub":"owner"}`},
		{"body handle", `{"name":"Agent","ownerSub":"owner","handle":"other-agent"}`},
		{"body provenance", `{"name":"Agent","ownerSub":"owner","registeredByKey":"ak-forged"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := rawCall(t, h, bearer, "POST", "/agents/register", "", []byte(tc.body), 400)
			require.Contains(t, string(data), `"error":"invalid"`)
		})
	}

	eventsBefore := call[map[string]any](h, "admin", "GET", "/events", nil, 200)
	data = rawCall(t, h, bearer, "POST", "/agents/register", "register-start", body, 201)
	var agent domain.Agent
	require.NoError(t, json.Unmarshal(data, &agent))
	require.Equal(t, "self-agent", agent.Handle)
	require.Equal(t, "Self Agent", agent.Name)
	require.Equal(t, "Registers itself", agent.Description)
	require.Equal(t, domain.Person{Sub: "owner", Name: "Olivia Owner"}, agent.Owner)
	require.NotNil(t, agent.RegisteredByKey)
	require.Equal(t, "ak-register", *agent.RegisteredByKey)
	require.False(t, agent.Disabled)
	require.NoError(t, h.database.InWorkspace(t.Context(), "pj-test", false, func(tx *store.Tx) error {
		stored, err := tx.Agent(agent.ID)
		require.NoError(t, err)
		require.Equal(t, agent.Owner, stored.Owner)
		require.Equal(t, agent.RegisteredByKey, stored.RegisteredByKey)
		return nil
	}))
	for _, input := range [][]byte{body, []byte(`{"name":"","description":"Ignored","ownerSub":"agent:ignored"}`)} {
		data = rawCall(t, h, bearer, "POST", "/agents/register", "register-start", input, 200)
		var existing domain.Agent
		require.NoError(t, json.Unmarshal(data, &existing))
		require.Equal(t, agent.ID, existing.ID)
		require.Equal(t, agent.Name, existing.Name)
		require.Equal(t, agent.Description, existing.Description)
		require.Equal(t, agent.Owner, existing.Owner)
		require.Equal(t, agent.RegisteredByKey, existing.RegisteredByKey)
		require.Equal(t, agent.CreatedAt, existing.CreatedAt)
		require.Equal(t, agent.UpdatedAt, existing.UpdatedAt)
	}
	data = rawCall(t, h, bearer, "POST", "/agents/register", strings.Repeat("k", 129), body, 200)
	require.Contains(t, string(data), `"id":"`+agent.ID+`"`, "the idempotency header is ignored, not validated")
	eventsAfter := call[map[string]any](h, "admin", "GET", "/events", nil, 200)
	require.Equal(t, eventsBefore, eventsAfter, "registration must not emit an issue event")
	data = rawCall(t, h, bearer, "POST", "/agents/register", "", []byte(`{"name":123,"ownerSub":"owner"}`), 400)
	require.Contains(t, string(data), `"error":"invalid"`, "an existing agent must still decode the body shape")
	data = rawCall(t, h, bearer, "GET", "/me", "", nil, 200)
	require.Contains(t, string(data), `"kind":"agent"`)
	require.Contains(t, string(data), `"sub":"agent:`+agent.ID+`"`)

	rotated := assertion(accesskey.Subject{Kind: accesskey.SubjectExternal, ID: "self-agent"}, "ak-rotated", scopeWrite)
	data = rawCall(t, h, rotated, "POST", "/agents/register", "", body, 200)
	var existing domain.Agent
	require.NoError(t, json.Unmarshal(data, &existing))
	require.Equal(t, agent.RegisteredByKey, existing.RegisteredByKey)
	patched := call[domain.Agent](h, "admin", "PATCH", "/agents/"+agent.ID, map[string]string{"name": "Renamed", "description": "Updated", "ownerSub": "admin"}, 200)
	require.Equal(t, agent.RegisteredByKey, patched.RegisteredByKey)
	call[any](h, "admin", "PATCH", "/agents/"+agent.ID, map[string]string{"registeredByKey": "ak-forged"}, 400)
	disabled := call[domain.Agent](h, "admin", "PATCH", "/agents/"+agent.ID, map[string]bool{"disabled": true}, 200)
	require.Equal(t, agent.RegisteredByKey, disabled.RegisteredByKey)
	data = rawCall(t, h, bearer, "POST", "/agents/register", "register-start", body, 403)
	require.Contains(t, string(data), `"error":"key_subject"`)
	require.Contains(t, string(data), "The access key subject is not an active registered agent")
	t.Run("disabled routes", checkBlockedRoutes)
	agents := call[items[domain.Agent]](h, "admin", "GET", "/agents?includeDisabled=true", nil, 200)
	require.Len(t, agents.Items, 1)
	require.True(t, agents.Items[0].Disabled)
	require.Equal(t, patched.Name, agents.Items[0].Name)
	require.Equal(t, patched.Owner, agents.Items[0].Owner)
	require.Equal(t, agent.RegisteredByKey, agents.Items[0].RegisteredByKey)

	// Registration is allowed with write alone, and uses character/byte limits.
	limits := []byte(`{"name":"` + strings.Repeat("あ", 200) + `","description":"` + strings.Repeat("é", 2048) + `","ownerSub":"owner"}`)
	rawCall(t, h, external("limit-agent", scopeWrite), "POST", "/agents/register", "", limits, 201)
	adminAgent := rawCall(t, h, "Bearer "+token("admin"), "POST", "/agents", "", []byte(`{"handle":"admin-agent","name":"Admin Agent","ownerSub":"admin"}`), 201)
	require.Contains(t, string(adminAgent), `"registeredByKey":null`)
	data = rawCall(t, h, external("admin-agent", scopeWrite), "POST", "/agents/register", "", body, 200)
	require.Contains(t, string(data), `"registeredByKey":null`, "self-registration cannot take credit for an Admin-created agent")
}

func TestAgentSelfRegistrationContract(t *testing.T) {
	allowed := []string{}
	for _, route := range (&API{}).routes() {
		if route.unregistered {
			allowed = append(allowed, route.pattern)
		}
	}
	require.ElementsMatch(t, []string{"POST /agents/register", "GET /agent-guide"}, allowed)
	var document struct {
		Components struct {
			Schemas map[string]struct {
				Properties           map[string]json.RawMessage `json:"properties"`
				Required             []string                   `json:"required"`
				AdditionalProperties bool                       `json:"additionalProperties"`
			} `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]struct {
			Responses map[string]json.RawMessage `json:"responses"`
		} `json:"paths"`
	}
	require.NoError(t, json.Unmarshal(openapiDocument, &document))
	agent := document.Components.Schemas["Agent"]
	require.Contains(t, agent.Required, "registeredByKey")
	var provenance struct {
		AnyOf []map[string]string `json:"anyOf"`
	}
	require.NoError(t, json.Unmarshal(agent.Properties["registeredByKey"], &provenance))
	require.ElementsMatch(t, []map[string]string{{"type": "string"}, {"type": "null"}}, provenance.AnyOf)
	input := document.Components.Schemas["AgentRegister"]
	require.ElementsMatch(t, []string{"name", "ownerSub"}, input.Required)
	require.NotContains(t, input.Properties, "handle")
	require.NotContains(t, input.Properties, "registeredByKey")
	require.False(t, input.AdditionalProperties)
	for _, status := range []string{"200", "201", "400", "401", "403", "503"} {
		require.Contains(t, document.Paths["/agents/register"]["post"].Responses, status)
	}
}
