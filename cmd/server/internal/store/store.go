package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore"
	"github.com/lib/pq"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store owns the tracker's queries and schema over the shared transaction runner.
type Store struct{ *pgstore.Store }
type Tx struct {
	*pgstore.Tx
	WorkspaceID string
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	database, err := pgstore.Open(ctx, dsn, migrations, "tracker_schema_migrations")
	if err != nil {
		return nil, err
	}
	return &Store{Store: database}, nil
}

func (s *Store) Do(ctx context.Context, write bool, fn func(*Tx) error) error {
	return translate(s.Store.Do(ctx, write, func(tx *pgstore.Tx) error { return fn(&Tx{Tx: tx}) }))
}

func (s *Store) InWorkspace(ctx context.Context, workspace string, write bool, fn func(*Tx) error) error {
	return s.Do(ctx, write, func(tx *Tx) error {
		tx.WorkspaceID = workspace
		return fn(tx)
	})
}

func invalid(message string) error { return httpx.Fail(400, "invalid", message) }

func translate(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return httpx.NotFound()
	}
	var pg *pq.Error
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return httpx.Conflict("This value is already in use")
		case "23503", "23514":
			return invalid("A referenced resource or value is invalid")
		}
	}
	return err
}
