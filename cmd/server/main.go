package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/appthrust/appserver-go/appserver/platformenv"
)

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	defaultStaticDir := os.Getenv("TRACKER_STATIC_DIR")
	if defaultStaticDir == "" {
		defaultStaticDir = "/srv/tracker"
	}
	staticDir := flag.String("static-dir", defaultStaticDir, "static SPA tracker")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("usage: tracker-server [--listen :8080] [--static-dir /srv/tracker]")
	}
	// Validate platform configuration before opening the database.
	platform, err := platformenv.FromEnv()
	if err != nil {
		log.Fatal(err)
	}
	if err := platformenv.ValidateIdentityListen(*listen, platform.OIDCIssuer); err != nil {
		log.Fatal(err)
	}
	upstreamURL, projectID := platform.APIURL, platform.ProjectID
	tracker, closeTracker, err := trackerHandler(upstreamURL, projectID)
	if err != nil {
		log.Fatal(err)
	}
	defer closeTracker()
	handler, err := newHandler(*staticDir, upstreamURL, projectID, tracker, tracker.Ready)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	log.Printf("tracker-server listening on %s", *listen)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
