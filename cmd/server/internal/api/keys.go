package api

import (
	"slices"

	"github.com/appthrust/appserver-go/accesskey"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
)

// Access Key scopes declared by catalog/entry.yaml (access.accessKeys.scopes).
const (
	scopeRead  = "tracker:read"
	scopeWrite = "tracker:write"
)

// keyActor maps an Access Key assertion to the actor it may act as.
//
// The Project claim is the tenant boundary. All keys remain Viewers and never
// reach Platform role lookup or Directory. External subjects are resolved to
// active registered agents inside the request transaction, except on routes
// explicitly admitting keys before registration.
func keyActor(principal accesskey.Principal, project string, mutation bool) (domain.Actor, error) {
	if principal.Project != project {
		return domain.Actor{}, httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
	}
	subject, err := accesskey.ParseSubject(principal.Subject)
	if err != nil || (subject.Kind != accesskey.SubjectUser && subject.Kind != accesskey.SubjectExternal) {
		return domain.Actor{}, httpx.Fail(403, "key_subject", "Only user or registered external access keys can call this API")
	}
	required := scopeRead
	if mutation {
		required = scopeWrite
	}
	if !slices.Contains(principal.Scopes, required) {
		return domain.Actor{}, httpx.Fail(403, "insufficient_scope", "The access key does not permit this operation")
	}
	kind := "person"
	if subject.Kind == accesskey.SubjectExternal {
		kind = "agent"
	}
	return domain.Actor{Person: domain.Person{Sub: subject.ID, Name: subject.ID}, Role: "Viewer", Kind: kind, Key: true, Scopes: principal.Scopes}, nil
}
