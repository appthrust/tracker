package store

import (
	"bytes"
	"database/sql"
	"errors"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
)

type Replay struct {
	Status int
	Body   []byte
}

func (t *Tx) Idempotency(actor, key string, hash []byte) (*Replay, error) {
	// InWorkspace(write=true) serializes concurrent uses of the same key, and
	// the cached response commits atomically with the write it represents.
	if err := t.Exec(`DELETE FROM tracker_idempotency WHERE workspace_id=$1 AND expires_at<=$2`, t.WorkspaceID, t.now()); err != nil {
		return nil, err
	}
	var replay Replay
	var previous []byte
	err := t.SQL.QueryRowContext(t.Context, `SELECT request_hash,status,body FROM tracker_idempotency WHERE workspace_id=$1 AND actor_sub=$2 AND key=$3`, t.WorkspaceID, actor, key).Scan(&previous, &replay.Status, &replay.Body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(previous, hash) {
		return nil, httpx.Conflict("Idempotency-Key was already used for a different request")
	}
	return &replay, nil
}

func (t *Tx) SaveIdempotency(actor, key string, hash []byte, replay Replay) error {
	return t.Exec(`INSERT INTO tracker_idempotency(workspace_id,actor_sub,key,request_hash,status,body,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, t.WorkspaceID, actor, key, hash, replay.Status, replay.Body, t.now().Add(24*time.Hour))
}

// ResponseAttempt rolls back failed handler writes before caching their response.
// In particular a PostgreSQL constraint error must not poison the transaction.
func (t *Tx) ResponseAttempt(fn func() error) error {
	if err := t.Exec(`SAVEPOINT tracker_response`); err != nil {
		return err
	}
	if err := fn(); err != nil {
		if rollback := t.Exec(`ROLLBACK TO SAVEPOINT tracker_response`); rollback != nil {
			return rollback
		}
		if release := t.Exec(`RELEASE SAVEPOINT tracker_response`); release != nil {
			return release
		}
		return translate(err)
	}
	return t.Exec(`RELEASE SAVEPOINT tracker_response`)
}
