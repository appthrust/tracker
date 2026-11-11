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
// The assertion audience is the same in every Project, so the Project claim is
// the tenant boundary. A key acts as the person it was issued to with the
// Viewer role: it never reaches the Platform role lookup, so Admin-only
// operations stay with signed-in users. Keys without a person behind them
// (component, external, cluster) are refused because every Tracker write
// records a person.
func keyActor(principal accesskey.Principal, project string, mutation bool) (domain.Actor, error) {
	if principal.Project != project {
		return domain.Actor{}, httpx.Fail(401, "unauthenticated", "A valid bearer token is required")
	}
	subject, err := accesskey.ParseSubject(principal.Subject)
	if err != nil || subject.Kind != accesskey.SubjectUser {
		return domain.Actor{}, httpx.Fail(403, "key_subject", "Only access keys issued to a user can call this API")
	}
	required := scopeRead
	if mutation {
		required = scopeWrite
	}
	if !slices.Contains(principal.Scopes, required) {
		return domain.Actor{}, httpx.Fail(403, "insufficient_scope", "The access key does not permit this operation")
	}
	return domain.Actor{Person: domain.Person{Sub: subject.ID, Name: subject.ID}, Role: "Viewer"}, nil
}
