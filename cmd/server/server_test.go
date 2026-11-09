package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConfigValidation(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "")
	staticDir := t.TempDir()
	for _, origin := range []string{"https://dashboard.example.test", "http://127.0.0.1:1", "http://localhost:8080"} {
		_, err := newHandler(staticDir, origin, "pj-test", nil, nil)
		require.NoError(t, err)
	}
	for _, origin := range []string{"http://dashboard.example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?q=1", ""} {
		handler, err := newHandler(staticDir, origin, "pj-test", nil, nil)
		require.EqualError(t, err, "PLATFORM_API_URL must be an HTTPS origin (HTTP is allowed only for loopback hosts)")
		require.Nil(t, handler)
	}
	handler, err := newHandler(staticDir, "https://example.test", "BAD", nil, nil)
	require.EqualError(t, err, "PLATFORM_PROJECT_ID must be a non-empty DNS label (at most 63 lowercase alphanumeric or hyphen characters, starting and ending with alphanumeric)")
	require.Nil(t, handler)
	for _, origin := range []string{"http://example.test", "https://example.test/", "https://example.test/#"} {
		t.Setenv("TRACKER_PUBLIC_URL", origin)
		_, _, err := trackerHandler("http://127.0.0.1:1", "pj-test")
		require.Error(t, err)
	}
	t.Setenv("TRACKER_PUBLIC_URL", "")
	for _, origin := range []string{"ftp://example.test", "http://example.test/path", "https://user:pass@example.test"} {
		t.Setenv("TRACKER_DIRECTORY_URL", origin)
		_, _, err := trackerHandler("http://127.0.0.1:1", "pj-test")
		require.Error(t, err)
	}
}

func TestHandlersRejectInvalidIdentityCA(t *testing.T) {
	t.Setenv("PLATFORM_OIDC_ISSUER", "https://issuer.example.test")
	t.Setenv("PLATFORM_OIDC_ISSUER_CA_PEM", "invalid PEM")
	tracker, cleanup, err := trackerHandler("https://platform.example.test", "pj-test")
	require.EqualError(t, err, "OIDC CA PEM must contain only PEM certificates")
	require.Nil(t, tracker)
	require.Nil(t, cleanup)
	handler, err := newHandler(t.TempDir(), "https://platform.example.test", "pj-test", nil, nil)
	require.EqualError(t, err, "OIDC CA PEM must contain only PEM certificates")
	require.Nil(t, handler)
}

func TestPendingSurfaceAndRelease(t *testing.T) {
	for _, key := range []string{"TRACKER_DATABASE_URL", "DATABASE_URL", "TRACKER_PUBLIC_URL", "TRACKER_DIRECTORY_URL", "PLATFORM_OIDC_ISSUER", "PLATFORM_OIDC_ISSUER_CA_PEM"} {
		t.Setenv(key, "")
	}
	t.Setenv("TRACKER_DIRECTORY_PUBLIC_URL", "https://directory.example.test")
	for key, value := range map[string]string{"TRACKER_RELEASE_VERSION": "release", "TRACKER_SOURCE_REVISION": "", "TRACKER_ARTIFACT_DIGEST": "digest"} {
		t.Setenv(key, value)
	}
	tracker, cleanup, err := trackerHandler("http://127.0.0.1:1", "pj-test")
	require.NoError(t, err)
	defer cleanup()
	handler, err := newHandler(t.TempDir(), "http://127.0.0.1:1", "pj-test", tracker, tracker.Ready)
	require.NoError(t, err)
	for path, status := range map[string]int{"/healthz": 200, "/readyz": 200, "/api/tracker/v1/me": 503, "/releasez": 200, "/api/unknown": 404} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, status, w.Code, path)
		if path == "/releasez" {
			require.JSONEq(t, `{"releaseVersion":"release","artifactDigest":"digest"}`, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/config", nil))
	var config map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &config))
	require.Equal(t, map[string]string{"projectId": "pj-test", "publicUrl": "", "directoryUrl": "https://directory.example.test"}, config)
	t.Setenv("TRACKER_DATABASE_URL", "postgres://postgres@127.0.0.1:1/tracker?sslmode=disable&connect_timeout=1")
	pending, stop, err := trackerHandler("http://127.0.0.1:1", "pj-test")
	require.NoError(t, err)
	defer stop()
	handler, err = newHandler(t.TempDir(), "http://127.0.0.1:1", "pj-test", pending, pending.Ready)
	require.NoError(t, err)
	for path, status := range map[string]int{"/healthz": 200, "/readyz": 503, "/api/tracker/v1/me": 503} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, status, w.Code, path)
	}
}
