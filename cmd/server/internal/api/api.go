package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

type API struct {
	store              *store.Store
	identity           *identity.Authenticator
	platform           *platformclient.Client
	links              *link.Client
	directoryPublicURL string
	mux                *http.ServeMux
}
type request struct {
	r      *http.Request
	w      http.ResponseWriter
	tx     *store.Tx
	author domain.Author
	access platformclient.ProjectAccess
	bearer string
}
type endpoint func(*request) (any, int, error)

// New serves the tracker API. directoryPublicURL is the browser origin of the
// Directory built-in app (empty when the link is not configured); the SPA builds
// profile links from it.
func New(database *store.Store, auth *identity.Authenticator, upstream *platformclient.Client, links *link.Client, directoryPublicURL string) http.Handler {
	a := &API{store: database, identity: auth, platform: upstream, links: links, directoryPublicURL: directoryPublicURL, mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /api/tracker/v1/openapi.json", a.openapi)
	a.route("GET /api/tracker/v1/me", true, true, a.me)
	a.route("GET /api/tracker/v1/articles", false, false, a.timeline)
	a.route("GET /api/tracker/v1/drafts", false, false, a.drafts)
	a.route("POST /api/tracker/v1/articles", true, true, a.createArticle)
	a.route("GET /api/tracker/v1/articles/{id}", false, false, a.article)
	a.route("PATCH /api/tracker/v1/articles/{id}", true, true, a.patchArticle)
	a.route("DELETE /api/tracker/v1/articles/{id}", true, true, a.deleteArticle)
	a.route("PUT /api/tracker/v1/articles/{id}/like", true, true, a.like)
	a.route("DELETE /api/tracker/v1/articles/{id}/like", true, true, a.like)
	a.route("GET /api/tracker/v1/authors/{id}", false, false, a.profile)
	a.route("GET /api/tracker/v1/authors/{id}/followers", false, false, a.followers)
	a.route("GET /api/tracker/v1/authors/{id}/following", false, false, a.following)
	a.route("PUT /api/tracker/v1/authors/{id}/follow", true, true, a.follow)
	a.route("DELETE /api/tracker/v1/authors/{id}/follow", true, true, a.follow)
	a.route("/", false, false, func(*request) (any, int, error) { return nil, 0, httpx.NotFound() })
	return a
}
func Unavailable() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteError(w, httpx.Fail(503, "tracker_store_unavailable", "The tracker database is not available"), "tracker")
	})
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.mux.ServeHTTP(w, r)
}
func (a *API) route(pattern string, mutation, needsRoles bool, fn endpoint) {
	a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		claims, bearer, ok := a.authenticate(w, r)
		if !ok {
			return
		}
		s := &request{r: r, w: w, bearer: bearer}
		var err error
		if needsRoles {
			s.access, err = a.platform.Access(ctx, claims.Principal.Subject, bearer)
			if err != nil {
				httpx.WriteError(w, httpx.Fail(502, "upstream_unavailable", "The platform is temporarily unavailable"), "tracker")
				return
			}
		}
		var body any
		var status int
		err = a.store.Do(ctx, mutation, func(tx *store.Tx) error {
			s.tx = tx
			if mutation {
				s.author, err = tx.UpsertAuthor(claims.Principal.Subject, claims.Name, claims.Email)
			} else {
				s.author, err = tx.AuthorBySubject(claims.Principal.Subject)
				if errors.Is(err, sql.ErrNoRows) {
					err = nil
				}
			}
			if err != nil {
				return err
			}
			body, status, err = fn(s)
			return err
		})
		if err != nil {
			httpx.WriteError(w, err, "tracker")
			return
		}
		if status == 204 {
			w.WriteHeader(status)
			return
		}
		httpx.WriteJSON(w, status, body)
	})
}
func (a *API) authenticate(w http.ResponseWriter, r *http.Request) (identity.Identity, string, bool) {
	claims, bearer, err := a.identity.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, identity.ErrUnavailable) {
			httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"), "tracker")
		} else if errors.Is(err, identity.ErrRawKeyNotAccepted) {
			httpx.WriteError(w, httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"), "tracker")
		} else {
			httpx.WriteError(w, httpx.Fail(401, "unauthenticated", "A valid bearer token is required"), "tracker")
		}
		return identity.Identity{}, "", false
	}
	return claims, bearer, true
}

func decode(s *request, target any) error { return decodeLimit(s, target, 256<<10) }
func decodeLimit(s *request, target any, limit int64) error {
	mediaType, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return httpx.Invalid("Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, limit))
	if err != nil {
		return httpx.Invalid("Request body exceeds the size limit")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return httpx.Invalid("Request body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return httpx.Invalid("Request body contains invalid or unknown fields")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return httpx.Invalid("Request body must contain one JSON object")
	}
	return nil
}

func validateArticle(title, body, status string) (string, error) {
	title = strings.TrimSpace(title)
	if n := utf8.RuneCountInString(title); n < 1 || n > 120 {
		return "", httpx.Invalid("Title must contain 1 to 120 characters")
	}
	if !utf8.ValidString(body) || len(body) > 100<<10 {
		return "", httpx.Invalid("Body must be valid UTF-8 and at most 100 KiB")
	}
	if status != "draft" && status != "published" {
		return "", httpx.Invalid("Status must be draft or published")
	}
	if status == "published" && strings.TrimSpace(body) == "" {
		return "", httpx.Invalid("Published articles require a body")
	}
	return title, nil
}
