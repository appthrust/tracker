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
	r      *http.Request
	w      http.ResponseWriter
	tx     *store.Tx
	actor  domain.Actor
	bearer string
}
type endpoint func(*request) (any, int, error)

func New(database *store.Store, auth *identity.Authenticator, upstream *platformclient.Client, people *directory.Client, workspace string) http.Handler {
	a := &API{store: database, identity: auth, platform: upstream, directory: people, workspace: workspace, mux: http.NewServeMux()}
	a.mux.HandleFunc("GET /api/tracker/v1/openapi.json", a.openapi)
	a.route("GET /me", false, true, a.me)
	a.route("GET /workspace", false, false, a.workspaceGet)
	a.route("PATCH /workspace", true, true, a.workspacePatch)
	a.route("GET /statuses", false, false, a.statusList)
	a.route("POST /statuses", true, true, a.statusCreate)
	a.route("PATCH /statuses/{id}", true, true, a.statusPatch)
	a.route("DELETE /statuses/{id}", true, true, a.statusDelete)
	a.route("PUT /statuses/order", true, true, a.statusOrder)
	a.route("GET /labels", false, false, a.labelList)
	a.route("POST /labels", true, true, a.labelCreate)
	a.route("PATCH /labels/{id}", true, true, a.labelPatch)
	a.route("DELETE /labels/{id}", true, true, a.labelDelete)
	a.route("GET /projects", false, false, a.projectList)
	a.route("POST /projects", true, false, a.projectCreate)
	a.route("GET /projects/{id}", false, false, a.projectGet)
	a.route("PATCH /projects/{id}", true, true, a.projectPatch)
	a.route("DELETE /projects/{id}", true, true, a.projectDelete)
	a.route("GET /sprints", false, false, a.sprintList)
	a.route("POST /sprints", true, false, a.sprintCreate)
	a.route("GET /sprints/{id}", false, false, a.sprintGet)
	a.route("PATCH /sprints/{id}", true, false, a.sprintPatch)
	a.route("POST /sprints/{id}/start", true, false, a.sprintStart)
	a.route("POST /sprints/{id}/close", true, false, a.sprintClose)
	a.route("DELETE /sprints/{id}", true, true, a.sprintDelete)
	a.route("GET /sprints/{id}/burndown", false, false, a.sprintBurndown)
	a.route("GET /velocity", false, false, a.velocity)
	a.route("GET /issues", false, false, a.issueList)
	a.route("POST /issues", true, false, a.issueCreate)
	a.route("GET /issues/{id}", false, false, a.issueGet)
	a.route("PATCH /issues/{id}", true, false, a.issuePatch)
	a.route("DELETE /issues/{id}", true, true, a.issueDelete)
	a.route("GET /issues/{id}/timeline", false, false, a.timeline)
	a.route("POST /issues/{id}/comments", true, false, a.commentCreate)
	a.route("PATCH /comments/{id}", true, false, a.commentPatch)
	a.route("DELETE /comments/{id}", true, true, a.commentDelete)
	a.route("POST /issues/{id}/attachments", true, false, a.attachmentCreate)
	a.route("GET /attachments/{id}", false, false, a.attachmentGet)
	a.route("DELETE /attachments/{id}", true, true, a.attachmentDelete)
	a.route("GET /views", false, false, a.viewList)
	a.route("POST /views", true, true, a.viewCreate)
	a.route("PATCH /views/{id}", true, true, a.viewPatch)
	a.route("DELETE /views/{id}", true, true, a.viewDelete)
	a.route("GET /people", false, false, a.people)
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
func (a *API) route(pattern string, mutation, roles bool, fn endpoint) {
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
		if claims.Principal.Kind == "key" {
			actor, err := keyActor(claims.Principal, a.workspace, mutation)
			if err != nil {
				httpx.WriteError(w, err, "tracker")
				return
			}
			// The assertion is addressed to Tracker only: it is never forwarded
			// to Directory, so people stay the stored snapshots.
			s.actor = actor
			if mutation {
				log.Printf("tracker access key mutation: %s %s key=%q subject=%q request_id=%q", r.Method, r.URL.Path, claims.Principal.KeyName, actor.Sub, r.Header.Get("X-Request-Id"))
			}
		} else {
			s.bearer = r.Header.Get("Authorization")
			s.actor = domain.Actor{Person: domain.Person{Sub: claims.Principal.Subject, Name: claims.Name, Email: claims.Email}, Role: "Viewer"}
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
		var body any
		var status int
		err := a.store.InWorkspace(ctx, a.workspace, mutation, func(tx *store.Tx) error { s.tx = tx; var err error; body, status, err = fn(s); return err })
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
