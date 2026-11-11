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
	"net/url"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
)

func TestAccessKeyActsAsItsUserWithinScopeAndProject(t *testing.T) {
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	signer := accesskey.NewES256Signer("test-key", private)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/access/jwks.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(signer.JWKS())
	}))
	t.Cleanup(jwks.Close)
	issuer := accesskey.IssuerURL(jwks.URL)
	assertion := func(project string, subject accesskey.Subject, scopes ...string) string {
		token, err := signer.Sign(accesskey.Claims{
			Issuer: issuer, Audience: "tracker", Project: project, KeyName: "ak-test", Subject: subject,
			Scopes: scopes, JTI: "test", IssuedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute),
		})
		require.NoError(t, err)
		return "Bearer " + token
	}
	user := func(id string) accesskey.Subject { return accesskey.Subject{Kind: accesskey.SubjectUser, ID: id} }
	h := newHarnessTrusting(t, identity.Trust{AccessIssuer: issuer, AccessAudience: "tracker"})
	do := func(bearer, method, path string, body any) (int, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			data, err := json.Marshal(body)
			require.NoError(t, err)
			reader = bytes.NewReader(data)
		}
		r, err := http.NewRequest(method, h.server.URL+"/api/tracker/v1"+path, reader)
		require.NoError(t, err)
		r.Header.Set("Authorization", bearer)
		r.Header.Set("Content-Type", "application/json")
		response, err := h.server.Client().Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return response.StatusCode, data
	}

	// The harness grants Admin to the signed-in user "admin"; a key issued to
	// that user must still be a Viewer.
	both := assertion("pj-test", user("admin"), scopeRead, scopeWrite)
	status, data := do(both, "POST", "/issues", map[string]string{"title": "From an agent", "type": "task"})
	require.Equal(t, 201, status, string(data))
	var issue domain.Issue
	require.NoError(t, json.Unmarshal(data, &issue))
	require.Equal(t, "admin", issue.Reporter.Sub)

	page := call[store.Page](h, "admin", "GET", "/issues?filter="+url.QueryEscape(`{"reporter":["me"]}`), nil, 200)
	require.Len(t, page.Items, 1, "the signed-in user owns what their key reported")

	issue2 := map[string]string{"title": "Refused", "type": "task"}
	for _, test := range []struct {
		name, bearer, method, path string
		body                       any
		status                     int
		code                       string
	}{
		{"read", assertion("pj-test", user("admin"), scopeRead), "GET", "/issues/" + issue.ID, nil, 200, ""},
		{"read scope cannot write", assertion("pj-test", user("admin"), scopeRead), "POST", "/issues", issue2, 403, "insufficient_scope"},
		{"write scope cannot read", assertion("pj-test", user("admin"), scopeWrite), "GET", "/issues", nil, 403, "insufficient_scope"},
		{"other project", assertion("pj-other", user("admin"), scopeRead, scopeWrite), "GET", "/issues", nil, 401, "unauthenticated"},
		{"component subject", assertion("pj-test", accesskey.Subject{Kind: accesskey.SubjectComponent, ID: "web"}, scopeRead, scopeWrite), "GET", "/issues", nil, 403, "key_subject"},
		{"admin issue delete", both, "DELETE", "/issues/" + issue.ID, nil, 403, "forbidden"},
		{"admin workspace settings", both, "PATCH", "/workspace", map[string]string{"key": "NEW"}, 403, "forbidden"},
		{"directory avatar", both, "GET", "/people/01JABCDEFGHJKMNPQRSTVWXYZ0/avatar", nil, 403, "key_subject"},
	} {
		status, data := do(test.bearer, test.method, test.path, test.body)
		require.Equal(t, test.status, status, "%s: %s", test.name, data)
		if test.code != "" {
			require.Contains(t, string(data), `"error":"`+test.code+`"`, test.name)
		}
	}

	secret, err := accesskey.Generate("trk", rand.Reader)
	require.NoError(t, err)
	status, data = do("Bearer "+secret.String(), "GET", "/issues", nil)
	require.Equal(t, 401, status)
	require.Contains(t, string(data), `"error":"raw_key_not_accepted"`)
}
