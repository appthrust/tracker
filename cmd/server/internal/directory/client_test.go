package directory

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestPeopleBearerCacheAndSnapshot(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "/api/directory/v1/people", r.URL.Path)
		require.Contains(t, []string{"bEaReR caller-token", "Bearer another-token"}, r.Header.Get("Authorization"))
		require.Equal(t, "20", r.URL.Query().Get("limit"))
		httpx.WriteJSON(w, 200, map[string]any{"items": []any{map[string]string{"id": "person-1", "subject": "alex", "displayName": "Directory Alex", "email": "alex@example.test"}, map[string]string{"id": "unlinked", "displayName": "No subject"}}})
	}))
	defer server.Close()
	resolver := link.NewResolver(platformclient.New("http://127.0.0.1:1", "pj-test"), "tracker", func(key string) (string, bool) {
		if key == "TRACKER_DIRECTORY_URL" {
			return server.URL, true
		}
		return "", false
	}, map[string]link.Required{"directory": {URLEnv: "TRACKER_DIRECTORY_URL"}})
	client := New(link.NewClient(resolver, nil), "https://directory.example.test")
	for range 2 {
		people, err := client.Search(t.Context(), "bEaReR caller-token", "Alex")
		require.NoError(t, err)
		require.Len(t, people, 1)
		require.Equal(t, "alex", people[0].Sub)
		require.Equal(t, "Directory Alex", people[0].Name)
	}
	require.EqualValues(t, 1, calls.Load())
	_, err := client.Search(t.Context(), "Bearer another-token", "Alex")
	require.NoError(t, err)
	require.EqualValues(t, 2, calls.Load())
	client.mu.Lock()
	for key, value := range client.cache {
		value.Expires = time.Now().Add(-time.Second)
		client.cache[key] = value
	}
	client.mu.Unlock()
	_, err = client.Search(t.Context(), "bEaReR caller-token", "Alex")
	require.NoError(t, err)
	require.EqualValues(t, 3, calls.Load())
	snapshot := domain.Person{Sub: "alex", Name: "Snapshot"}
	require.Equal(t, snapshot, New(nil, "").Enrich(t.Context(), "Bearer token", snapshot))
	_, err = New(nil, "").Search(t.Context(), "Bearer token", "")
	require.ErrorIs(t, err, link.ErrAbsent)
}

func TestAvatarURLUsesTrackerOriginWithoutDirectoryPublicURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/directory/v1/people", r.URL.Path)
		httpx.WriteJSON(w, 200, map[string]any{"items": []any{
			map[string]string{"id": "person-1", "subject": "alex", "displayName": "Alex", "avatarVersion": "2026-11-10T01:02:03.123Z"},
			map[string]string{"id": "person-2", "subject": "sam", "displayName": "Sam"},
		}})
	}))
	defer server.Close()
	resolver := link.NewResolver(platformclient.New("http://127.0.0.1:1", "pj-test"), "tracker", func(key string) (string, bool) {
		return server.URL, key == "TRACKER_DIRECTORY_URL"
	}, map[string]link.Required{"directory": {URLEnv: "TRACKER_DIRECTORY_URL"}})
	for _, publicURL := range []string{"", "https://directory.example.test"} {
		client := New(link.NewClient(resolver, nil), publicURL)
		people, err := client.Search(t.Context(), "Bearer token", "")
		require.NoError(t, err)
		require.Len(t, people, 2)
		require.Equal(t, "/api/tracker/v1/people/person-1/avatar?v=2026-11-10T01%3A02%3A03.123Z", people[0].AvatarURL)
		require.Empty(t, people[1].AvatarURL)
		require.Equal(t, people[0], client.Enrich(t.Context(), "Bearer token", domain.Person{Sub: "alex", Name: "Snapshot"}))
		if publicURL != "" {
			require.Equal(t, publicURL+"/people/person-1", people[0].ProfileURL)
		} else {
			require.Empty(t, people[0].ProfileURL)
		}
	}
}
