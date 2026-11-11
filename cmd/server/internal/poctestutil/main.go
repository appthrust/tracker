// Command poctestutil serves disposable JWKS and the same Admin role fixture as
// hack/smoke.sh. It is only used by the local, non-authoritative agents PoC.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/appthrust/appserver-go/accesskey"
)

func main() {
	output := flag.String("output", "", "private temporary token bundle path")
	flag.Parse()
	if *output == "" {
		log.Fatal("--output is required")
	}
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	signer := accesskey.NewES256Signer("agents-poc", private)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	issuer := accesskey.IssuerURL(origin)
	bundle := map[string]string{"origin": origin, "issuer": issuer}
	for _, subject := range []accesskey.Subject{
		{Kind: accesskey.SubjectExternal, ID: "poc-astra"},
		{Kind: accesskey.SubjectExternal, ID: "poc-other"},
		{Kind: accesskey.SubjectUser, ID: "poc-person"},
	} {
		now := time.Now()
		token, err := signer.Sign(accesskey.Claims{Issuer: issuer, Audience: "tracker", Project: "pj-agents-poc", KeyName: "ak-poc", Subject: subject, Scopes: []string{"tracker:read", "tracker:write"}, JTI: subject.ID, IssuedAt: now, ExpiresAt: now.Add(5 * time.Minute)})
		if err != nil {
			log.Fatal(err)
		}
		bundle[subject.ID] = token
	}
	claims, err := json.Marshal(map[string]string{"sub": "poc-person", "name": "PoC Person", "email": "poc@example.test"})
	if err != nil {
		log.Fatal(err)
	}
	bundle["person"] = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "."
	data, err := json.Marshal(bundle)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*output, data, 0600); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /access/jwks.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(signer.JWKS())
	})
	mux.HandleFunc("GET /api/v1/projects/pj-agents-poc/access", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+bundle["person"] {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"projectId": "pj-agents-poc", "member": true, "roles": []string{"Admin"}})
	})
	log.Fatal(http.Serve(listener, mux))
}
