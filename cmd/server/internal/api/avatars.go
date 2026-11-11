package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
)

// Avatars use Directory's data and authority, not a Tracker transaction.
func (a *API) avatar(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	claims, _, ok := a.authenticate(w, r)
	if !ok {
		return
	}
	if claims.Principal.Kind == "key" {
		// Directory owns avatars and does not accept Tracker's assertion.
		httpx.WriteError(w, httpx.Fail(403, "key_subject", "Access keys cannot read Directory avatars"), "tracker")
		return
	}
	id := r.PathValue("id")
	if id == "." || id == ".." || strings.ContainsAny(id, "/\\") {
		httpx.WriteError(w, invalid("Invalid Directory person id"), "tracker")
		return
	}
	version := r.URL.Query().Get("v")
	data, contentType, err := a.directory.Avatar(ctx, r.Header.Get("Authorization"), id, version)
	if err != nil {
		var rejected *link.RejectedError
		var denied *link.DeniedError
		switch {
		case errors.Is(err, link.ErrAbsent), errors.As(err, &rejected) && rejected.Status == http.StatusNotFound:
			httpx.WriteError(w, httpx.NotFound(), "tracker")
		case errors.As(err, &denied):
			if denied.Status == http.StatusUnauthorized {
				httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "Directory requires a valid bearer token"), "tracker")
			} else {
				httpx.WriteError(w, httpx.Forbidden(), "tracker")
			}
		default:
			httpx.WriteError(w, httpx.Fail(502, "directory_avatar_unavailable", "The Directory avatar is not available"), "tracker")
		}
		return
	}

	// Directory serves the current photo even for an old v. Include the bytes
	// in the validator and do not promise immutable historical representations.
	hash := sha256.New()
	_, _ = io.WriteString(hash, version)
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write(data)
	etag := `"` + hex.EncodeToString(hash.Sum(nil)) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	if version != "" {
		w.Header().Set("Cache-Control", "private, max-age=86400")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}
