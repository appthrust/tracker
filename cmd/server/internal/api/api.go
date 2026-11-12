package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"slices"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/appthrust/tracker/cmd/server/internal/directory"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

type API struct {
	store     *store.Store
	identity  *identity.Authenticator
	platform  *platformclient.Client
	directory *directory.Client
	workspace string
	mux       *http.ServeMux
}
type request struct {
	r       *http.Request
	w       http.ResponseWriter
	tx      *store.Tx
	actor   domain.Actor
	bearer  string
	keyName string
}
type endpoint func(*request) (any, int, error)

func New(database *store.Store, auth *identity.Authenticator, upstream *platformclient.Client, people *directory.Client, workspace string) http.Handler {
	a := &API{store: database, identity: auth, platform: upstream, directory: people, workspace: workspace, mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /api/tracker/v1/openapi.json", a.openapi)
	for _, route := range a.routes() {
		a.route(route.pattern, route.mutation, route.roles, route.unregistered, route.handler)
	}
	a.mux.HandleFunc("GET /api/tracker/v1/people/{id}/avatar", a.avatar)
	a.mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { httpx.WriteError(w, httpx.NotFound(), "tracker") })
	return a
}
func Unavailable() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/api/tracker/v1/openapi.json" {
			serveOpenAPI(w)
			return
		}
		httpx.WriteError(w, httpx.Fail(503, "tracker_store_unavailable", "The tracker database is not available"), "tracker")
	})
}
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a.mux.ServeHTTP(w, r)
}
func (a *API) route(pattern string, mutation, roles, unregistered bool, fn endpoint) {
	method, path, _ := bytes.Cut([]byte(pattern), []byte(" "))
	a.mux.HandleFunc(string(method)+" /api/tracker/v1"+string(path), func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		claims, _, ok := a.authenticate(w, r)
		if !ok {
			return
		}
		s := &request{r: r, w: w}
		key := claims.Principal.Kind == "key"
		if key {
			actor, err := keyActor(claims.Principal, a.workspace, mutation)
			if err != nil {
				httpx.WriteError(w, err, "tracker")
				return
			}
			// The assertion is addressed to Tracker only: it is never forwarded
			// to Directory. The person's name comes from Tracker's own record.
			s.actor = actor
			s.keyName = claims.Principal.KeyName
			if mutation {
				log.Printf("tracker access key mutation: %s %s key=%q subject=%q request_id=%q", r.Method, r.URL.Path, claims.Principal.KeyName, actor.Sub, r.Header.Get("X-Request-Id"))
			}
		} else {
			s.bearer = r.Header.Get("Authorization")
			s.actor = domain.Actor{Person: domain.Person{Sub: claims.Principal.Subject, Name: claims.Name, Email: claims.Email}, Role: "Viewer", Kind: "person"}
			if s.actor.Name == "" {
				s.actor.Name = s.actor.Sub
			}
			if roles {
				access, err := a.platform.Access(ctx, s.actor.Sub, s.bearer)
				if err != nil {
					httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The platform role is temporarily unavailable"), "tracker")
					return
				}
				if !access.NotMember {
					s.actor.Role = access.Role
				}
			}
			if mutation {
				s.actor.Person = a.directory.Enrich(ctx, s.bearer, s.actor.Person)
			}
		}
		if err := a.store.EnsureWorkspace(ctx, a.workspace); err != nil {
			writeStoreError(w, err)
			return
		}
		if key && s.actor.Kind == "agent" {
			if err := a.store.Do(ctx, true, func(tx *store.Tx) error {
				tx.WorkspaceID = a.workspace
				return tx.ObserveAgent(s.actor.Sub)
			}); err != nil {
				writeStoreError(w, err)
				return
			}
		}
		var body any
		var status int
		err := a.store.InWorkspace(ctx, a.workspace, mutation, func(tx *store.Tx) error {
			s.tx = tx
			if key && s.actor.Kind == "agent" {
				actor, err := tx.AgentBySubject(s.actor.Sub)
				if err != nil {
					var response *httpx.Error
					if !unregistered || !errors.As(err, &response) || response.Code != "key_subject" {
						return err
					}
				} else {
					actor.Scopes = s.actor.Scopes
					s.actor = actor
				}
			} else if key {
				name, err := tx.KnownName(s.actor.Sub)
				if err != nil {
					return err
				}
				if name != "" {
					s.actor.Name = name
				}
			}
			var err error
			body, status, err = a.execute(s, fn)
			return err
		})
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if status == http.StatusNoContent {
			w.WriteHeader(status)
			return
		}
		if download, ok := body.(attachmentDownload); ok {
			download.write(w)
			return
		}
		if text, ok := body.(markdown); ok {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, string(text))
			return
		}
		if replay, ok := body.(store.Replay); ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(replay.Status)
			_, _ = w.Write(replay.Body)
			return
		}
		a.enrich(s, body)
		httpx.WriteJSON(w, status, body)
	})
}
func writeStoreError(w http.ResponseWriter, err error) {
	var field *domain.FieldError
	if errors.As(err, &field) {
		httpx.WriteJSON(w, 400, struct {
			Error   string              `json:"error"`
			Message string              `json:"message"`
			Issues  []domain.FieldError `json:"issues"`
		}{Error: "invalid", Message: field.Message, Issues: []domain.FieldError{*field}})
		return
	}
	httpx.WriteError(w, storeError(err), "tracker")
}
func storeError(err error) error {
	var response *httpx.Error
	if errors.As(err, &response) {
		return err
	}
	return httpx.Fail(503, "tracker_store_unavailable", "The tracker database is not available")
}
func invalid(message string) error { return httpx.Fail(400, "invalid", message) }
func (a *API) authenticate(w http.ResponseWriter, r *http.Request) (identity.Identity, string, bool) {
	claims, bearer, err := a.identity.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, identity.ErrUnavailable) {
			httpx.WriteError(w, httpx.Fail(503, "identity_unavailable", "The identity provider is temporarily unavailable"), "tracker")
		} else {
			// The edge has already accepted this request, so a 401 here is the app
			// disagreeing with the edge about the token; record why.
			log.Printf("tracker auth rejected: %s %s request_id=%q %s edge_cookies_expired=%d", r.Method, r.URL.Path, r.Header.Get("X-Request-Id"), describeRejection(r.Header.Get("Authorization"), err), expireEdgeSession(w, r))
			failure := httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
			if errors.Is(err, identity.ErrRawKeyNotAccepted) {
				failure = httpx.Fail(401, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API")
			}
			httpx.WriteError(w, failure, "tracker")
		}
		return identity.Identity{}, "", false
	}
	return claims, bearer, true
}
func decode(s *request, target any, nullable ...string) error {
	mediaType, _, err := mime.ParseMediaType(s.r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return invalid("Content-Type must be application/json")
	}
	body, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, 256<<10))
	if err != nil {
		return invalid("Request body exceeds the size limit")
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		return invalid("Request body must be a JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var typed *json.UnmarshalTypeError
		if errors.As(err, &typed) && (typed.Field == "estimate" || typed.Field == "sprintId") {
			return &domain.FieldError{Path: typed.Field, Message: "Value must be a string or null"}
		}
		return invalid("Request body contains invalid or unknown fields")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return invalid("Request body must contain one JSON object")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return invalid("Invalid request body")
	}
	for field, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) && !slices.Contains(nullable, field) {
			return invalid(field + " cannot be null")
		}
	}
	return nil
}
func admin(s *request) error {
	if !domain.Can(s.actor, domain.ManageWorkspace, domain.Target{}) {
		return httpx.Forbidden()
	}
	return nil
}

type items[T any] struct {
	Items []T `json:"items"`
}
