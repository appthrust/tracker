package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/directory"
	"github.com/stretchr/testify/require"
)

func avatarHandler(t *testing.T, upstream http.Handler) http.Handler {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	resolver := link.NewResolver(platformclient.New("http://127.0.0.1:1", "pj-test"), "tracker", func(key string) (string, bool) {
		return server.URL, key == "TRACKER_DIRECTORY_URL"
	}, map[string]link.Required{"directory": {URLEnv: "TRACKER_DIRECTORY_URL"}})
	auth, err := identity.New(identity.Trust{})
	require.NoError(t, err)
	// Avatars do not depend on a Tracker database or a Directory browser cookie.
	return New(nil, auth, nil, directory.New(link.NewClient(resolver, nil), ""), "pj-test")
}

func avatarRequest(handler http.Handler, path, bearer, etag string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/tracker/v1"+path, nil)
	r.Header.Set("Authorization", bearer)
	r.Header.Set("If-None-Match", etag)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestAvatarPassThroughAndVersionCache(t *testing.T) {
	for _, contentType := range []string{"image/png", "image/jpeg", "image/webp"} {
		t.Run(contentType, func(t *testing.T) {
			data := []byte("Directory image bytes")
			bearer := "bEaReR " + token("reader")
			handler := avatarHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/directory/v1/people/person-1/avatar", r.URL.Path)
				require.Equal(t, bearer, r.Header.Get("Authorization"))
				require.Empty(t, r.Header.Get("Cookie"))
				require.Equal(t, "image/*", r.Header.Get("Accept"))
				require.Empty(t, r.URL.Query().Get("url"))
				w.Header().Set("Content-Type", contentType)
				w.Header().Set("Set-Cookie", "directory-session=do-not-forward")
				_, _ = w.Write(data)
			}))
			path := "/people/person-1/avatar?v=2026-11-10T00%3A00%3A00Z&url=https://untrusted.invalid/"
			w := avatarRequest(handler, path, bearer, "")
			require.Equal(t, 200, w.Code, w.Body.String())
			require.Equal(t, data, w.Body.Bytes())
			require.Equal(t, contentType, w.Header().Get("Content-Type"))
			require.Empty(t, w.Header().Get("Set-Cookie"))
			require.Equal(t, "nosniff", w.Header().Get("X-Content-Type-Options"))
			require.Equal(t, "private, max-age=86400", w.Header().Get("Cache-Control"))
			tag := w.Header().Get("ETag")
			require.NotEmpty(t, tag)
			cached := avatarRequest(handler, path, bearer, tag)
			require.Equal(t, 304, cached.Code)
			require.Empty(t, cached.Body.Bytes())
			changed := avatarRequest(handler, "/people/person-1/avatar?v=2026-11-11T00%3A00%3A00Z", bearer, tag)
			require.Equal(t, 200, changed.Code)
			require.NotEqual(t, tag, changed.Header().Get("ETag"))
			unversioned := avatarRequest(handler, "/people/person-1/avatar", bearer, "")
			require.Equal(t, "private, no-cache", unversioned.Header().Get("Cache-Control"))
		})
	}
}

func TestAvatarRejectsUnsafeUpstream(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, body    string
		upstreamStatus, wantStatus int
		wantCode                   string
	}{
		{"no avatar", "application/json", `{"error":"not_found"}`, 404, 404, "not_found"},
		{"HTML", "text/html", "<html>login</html>", 200, 502, "directory_avatar_unavailable"},
		{"SVG", "image/svg+xml", "<svg/>", 200, 502, "directory_avatar_unavailable"},
		{"GIF", "image/gif", "GIF89a", 200, 502, "directory_avatar_unavailable"},
		{"empty", "image/png", "", 200, 502, "directory_avatar_unavailable"},
		{"oversized", "image/png", strings.Repeat("x", (512<<10)+1), 200, 502, "directory_avatar_unavailable"},
		{"transport bound", "image/png", strings.Repeat("x", (4<<20)+1), 200, 502, "directory_avatar_unavailable"},
		{"redirect", "text/html", "login", 302, 502, "directory_avatar_unavailable"},
		{"unavailable", "application/json", "{}", 503, 502, "directory_avatar_unavailable"},
		{"denied", "application/json", "{}", 403, 403, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := avatarHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/api/directory/v1/people/person-1/avatar", r.URL.Path)
				w.Header().Set("Content-Type", tc.contentType)
				w.Header().Set("Location", "/must-not-follow")
				w.WriteHeader(tc.upstreamStatus)
				w.(http.Flusher).Flush() // Also enforce the bound for chunked bodies without Content-Length.
				_, _ = w.Write([]byte(tc.body))
			}))
			w := avatarRequest(handler, "/people/person-1/avatar?v=1", "Bearer "+token("reader"), "")
			require.Equal(t, tc.wantStatus, w.Code, w.Body.String())
			var result httpx.Error
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
			require.Equal(t, tc.wantCode, result.Code)
			require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
			require.False(t, bytes.HasPrefix(w.Body.Bytes(), []byte("<html>")))
		})
	}
}

func TestAvatarRequiresAuthentication(t *testing.T) {
	handler := avatarHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("unauthenticated request reached Directory")
	}))
	for _, bearer := range []string{"", "Bearer invalid"} {
		w := avatarRequest(handler, "/people/person-1/avatar?v=1", bearer, `"cached"`)
		require.Equal(t, 401, w.Code)
		require.Contains(t, w.Body.String(), `"error":"unauthenticated"`)
	}
}
