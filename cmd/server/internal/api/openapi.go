package api

import (
	"context"
	_ "embed"
	"net/http"
	"time"
)

//go:embed openapi.json
var openapiDocument []byte

// The contract has the same realm-member read authority as Tracker data, but
// does not require a database transaction or a platform role lookup.
func (a *API) openapi(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, ok := a.authenticate(w, r.WithContext(ctx)); !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(openapiDocument)
}
