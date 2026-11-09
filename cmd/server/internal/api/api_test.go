package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/store"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"fmt"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	platform "github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"net/url"
)

type harness struct {
	t             *testing.T
	server        *httptest.Server
	failed        atomic.Bool
	projectStatus atomic.Int32
}

func token(subject string) string {
	claims, _ := json.Marshal(map[string]string{"sub": subject, "email": subject + "@example.test", "name": subject})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
}

func newHarness(t *testing.T, directoryURL ...string) *harness {
	t.Helper()
	database, _ := testutil.Database(t, store.Open)
	h := &harness{t: t}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.failed.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Error("platform request missing bearer")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		role := "Viewer"
		if r.Header.Get("Authorization") == "Bearer "+token("admin") {
			role = "Admin"
		} else if r.Header.Get("Authorization") == "Bearer "+token("editor") {
			role = "Editor"
		}
		switch r.URL.Path {
		case "/api/v1/projects/pj-test/app-installations/tracker":
			httpx.WriteJSON(w, 200, map[string]any{"id": "tracker", "links": []any{}})
		case "/api/v1/projects/pj-test/access":
			if status := int(h.projectStatus.Load()); status != 0 {
				w.WriteHeader(status)
				return
			}
			httpx.WriteJSON(w, 200, map[string]any{"member": true, "role": role})
		case "/api/v1/projects/pj-test/source-connections":
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "pending", "status": "incomplete"}, map[string]string{"id": "github", "status": "ready"}}})
		case "/api/v1/registry-connections":
			httpx.WriteJSON(w, 200, map[string]any{"data": []any{map[string]string{"id": "registry", "status": "ready"}}})
		default:
			t.Errorf("unexpected platform route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(upstream.Close)
	issuer := testutil.NewOIDCIssuer(t)
	auth, err := identity.New(identity.Trust{OIDCIssuer: issuer.Server.URL, OIDCCAPEM: issuer.CAPEM, OIDCAudiences: []string{"appthrust-platform-api"}})
	require.NoError(t, err)
	// Exercise a real signed bearer independently; subject-specific requests use the trust parser.
	_, _, err = auth.Authenticate(t.Context(), issuer.Bearer(t))
	require.NoError(t, err)
	auth, err = identity.New(identity.Trust{})
	if err != nil {
		t.Fatal(err)
	}
	client := platform.New(upstream.URL, "pj-test")
	var links *link.Client
	if len(directoryURL) > 0 {
		links = link.NewClient(link.NewResolver(client, "tracker", func(key string) (string, bool) {
			if key == "TRACKER_DIRECTORY_URL" {
				return directoryURL[0], true
			}
			return "", false
		}, map[string]link.Required{"directory": {URLEnv: "TRACKER_DIRECTORY_URL", PublicURLEnv: "TRACKER_DIRECTORY_PUBLIC_URL"}}), nil)
	}
	h.server = httptest.NewServer(New(database, auth, client, links, "https://directory.example.test"))
	t.Cleanup(h.server.Close)
	return h
}

func call[T any](h *harness, subject, method, path string, body any, status int) T {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	r, err := http.NewRequest(method, h.server.URL+"/api/tracker/v1"+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if subject != "" {
		r.Header.Set("Authorization", "Bearer "+token(subject))
	}
	r.Header.Set("Content-Type", "application/json")
	response, err := h.server.Client().Do(r)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	if response.StatusCode != status {
		h.t.Fatalf("%s %s (%s): HTTP %d, want %d: %s", method, path, subject, response.StatusCode, status, payload)
	}
	var result T
	if status != 204 {
		if err := json.Unmarshal(payload, &result); err != nil {
			h.t.Fatalf("decode %s: %v", payload, err)
		}
	}
	return result
}

func TestPublishingAuthorityAndSocial(t *testing.T) {
	h := newHarness(t)
	call[httpx.Error](h, "", "GET", "/me", nil, 401)
	draft := call[domain.Article](h, "writer", "POST", "/articles", map[string]any{"title": " Draft ", "body": "# Hello"}, 201)
	require.Equal(t, "Draft", draft.Title)
	require.Nil(t, draft.PublishedAt)
	call[httpx.Error](h, "other", "GET", "/articles/"+draft.ID, nil, 404)
	call[httpx.Error](h, "other", "PUT", "/articles/"+draft.ID+"/like", nil, 404)
	page := call[store.Page](h, "other", "GET", "/articles", nil, 200)
	require.Empty(t, page.Items)
	drafts := call[struct {
		Items []domain.ArticleSummary `json:"items"`
	}](h, "writer", "GET", "/drafts", nil, 200)
	require.Len(t, drafts.Items, 1)
	published := call[domain.Article](h, "writer", "PATCH", "/articles/"+draft.ID, map[string]string{"status": "published"}, 200)
	require.NotNil(t, published.PublishedAt)
	page = call[store.Page](h, "new-reader", "GET", "/articles", nil, 200)
	require.Len(t, page.Items, 1)
	require.False(t, page.Items[0].LikedByMe)
	call[httpx.Error](h, "other", "PATCH", "/articles/"+draft.ID, map[string]string{"title": "Stolen"}, 403)
	call[httpx.Error](h, "admin", "PATCH", "/articles/"+draft.ID, map[string]string{"title": "Stolen"}, 403)
	for range 2 {
		liked := call[struct {
			LikeCount int  `json:"likeCount"`
			LikedByMe bool `json:"likedByMe"`
		}](h, "other", "PUT", "/articles/"+draft.ID+"/like", nil, 200)
		require.Equal(t, 1, liked.LikeCount)
		require.True(t, liked.LikedByMe)
	}
	article := call[domain.Article](h, "other", "GET", "/articles/"+draft.ID, nil, 200)
	require.True(t, article.LikedByMe)
	call[any](h, "other", "DELETE", "/articles/"+draft.ID+"/like", nil, 200)
	call[any](h, "other", "DELETE", "/articles/"+draft.ID+"/like", nil, 200)
	call[httpx.Error](h, "writer", "PUT", "/authors/"+draft.Author.ID+"/follow", nil, 400)
	for range 2 {
		call[any](h, "other", "PUT", "/authors/"+draft.Author.ID+"/follow", nil, 200)
	}
	page = call[store.Page](h, "other", "GET", "/articles?following=true", nil, 200)
	require.Len(t, page.Items, 1)
	profile := call[domain.AuthorProfile](h, "other", "GET", "/authors/"+draft.Author.ID, nil, 200)
	require.True(t, profile.FollowedByMe)
	require.Equal(t, 1, profile.FollowerCount)
	call[httpx.Error](h, "other", "DELETE", "/articles/"+draft.ID, nil, 403)
	call[any](h, "admin", "DELETE", "/articles/"+draft.ID, nil, 204)
	call[httpx.Error](h, "writer", "GET", "/articles/"+draft.ID, nil, 404)
}
func TestTimelinePagingAndValidation(t *testing.T) {
	h := newHarness(t)
	for i := range 6 {
		call[domain.Article](h, "writer", "POST", "/articles", map[string]any{"title": fmt.Sprint(i), "body": "Published", "publish": true}, 201)
	}
	seen := map[string]bool{}
	path := "/articles?limit=2"
	for pageIndex := range 3 {
		page := call[store.Page](h, "reader", "GET", path, nil, 200)
		require.Len(t, page.Items, 2)
		for _, a := range page.Items {
			require.False(t, seen[a.ID])
			seen[a.ID] = true
		}
		if pageIndex < 2 {
			require.NotNil(t, page.NextCursor)
			path = "/articles?limit=2&cursor=" + url.QueryEscape(*page.NextCursor)
		} else {
			require.Nil(t, page.NextCursor)
		}
	}
	for _, path := range []string{"/articles?limit=0", "/articles?limit=51", "/articles?limit=x", "/articles?cursor=bad"} {
		call[httpx.Error](h, "reader", "GET", path, nil, 400)
	}
	for _, input := range []map[string]any{{"title": " ", "body": "a"}, {"title": strings.Repeat("あ", 121)}, {"title": "x", "body": strings.Repeat("a", 102401)}, {"title": "x", "body": " ", "publish": true}} {
		call[httpx.Error](h, "writer", "POST", "/articles", input, 400)
	}
}
func TestDirectoryRefreshAndAbsent(t *testing.T) {
	directory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer "+token("writer"), r.Header.Get("Authorization"))
		require.Equal(t, "/api/directory/v1/me", r.URL.Path)
		httpx.WriteJSON(w, 200, map[string]any{"person": map[string]string{"id": "p1", "displayName": "Dir Name"}})
	}))
	defer directory.Close()
	h := newHarness(t, directory.URL)
	me := call[meResponse](h, "writer", "GET", "/me", nil, 200)
	require.True(t, me.Directory.Linked)
	require.Equal(t, "Dir Name", me.Author.DisplayName)
	require.Equal(t, "p1", *me.Author.DirectoryPersonID)
	require.Equal(t, "https://directory.example.test", *me.Directory.PublicURL)
	// A later mutation upserts the author from the claims again; the linked
	// Directory name must not be overwritten by the claim name.
	article := call[domain.Article](h, "writer", "POST", "/articles", map[string]any{"title": "after link", "body": "x", "publish": true}, 201)
	require.Equal(t, "Dir Name", article.Author.DisplayName)
	absent := newHarness(t, "")
	me = call[meResponse](absent, "writer", "GET", "/me", nil, 200)
	require.False(t, me.Directory.Linked)
	require.Equal(t, "writer", me.Author.DisplayName)
}
