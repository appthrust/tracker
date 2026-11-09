package api

import (
	_ "embed"
	"net/http"
)

//go:embed openapi.json
var openapiDocument []byte

// OpenAPI is public even while the store is pending.
func (a *API) openapi(w http.ResponseWriter, _ *http.Request) { serveOpenAPI(w) }
func serveOpenAPI(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(openapiDocument)
}
