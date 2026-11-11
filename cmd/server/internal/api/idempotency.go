package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/appthrust/tracker/cmd/server/internal/store"
)

func (a *API) execute(s *request, fn endpoint) (any, int, error) {
	invoke := func() (any, int, error) {
		body, status, err := fn(s)
		if err != nil {
			return nil, 0, err
		}
		projection := responseActors(body)
		if err := s.tx.HydrateActors(projection.people); err != nil {
			return nil, 0, err
		}
		projection.apply()
		return body, status, nil
	}
	key := s.r.Header.Get("Idempotency-Key")
	if s.r.Method != http.MethodPost || key == "" || strings.HasSuffix(s.r.URL.Path, "/attachments") {
		return invoke()
	}
	if !domain.Text(key, 1, 128) {
		return nil, 0, invalid("Idempotency-Key must contain 1 to 128 characters")
	}
	data, err := io.ReadAll(http.MaxBytesReader(s.w, s.r.Body, 256<<10))
	if err != nil {
		return nil, 0, invalid("Request body exceeds the size limit")
	}
	s.r.Body = io.NopCloser(bytes.NewReader(data))
	hash := sha256.New()
	for _, part := range []string{s.r.Method, s.r.URL.RequestURI(), s.r.Header.Get("Content-Type")} {
		_, _ = io.WriteString(hash, part)
		_, _ = hash.Write([]byte{0})
	}
	_, _ = hash.Write(data)
	fingerprint := hash.Sum(nil)
	replay, err := s.tx.Idempotency(s.actor.Sub, key, fingerprint)
	if err != nil {
		return nil, 0, err
	}
	if replay != nil {
		return *replay, replay.Status, nil
	}
	var body any
	var status int
	err = s.tx.ResponseAttempt(func() error {
		var err error
		body, status, err = invoke()
		return err
	})
	response := store.Replay{Status: status, Body: []byte{}}
	if err != nil {
		capture := &responseCapture{header: http.Header{}}
		writeStoreError(capture, err)
		response.Status, response.Body = capture.status, capture.Bytes()
	} else if status != http.StatusNoContent {
		response.Body, err = json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		response.Body = append(response.Body, '\n')
	}
	if err := s.tx.SaveIdempotency(s.actor.Sub, key, fingerprint, response); err != nil {
		return nil, 0, err
	}
	return response, response.Status, nil
}

type responseCapture struct {
	bytes.Buffer
	header http.Header
	status int
}

func (w *responseCapture) Header() http.Header    { return w.header }
func (w *responseCapture) WriteHeader(status int) { w.status = status }
