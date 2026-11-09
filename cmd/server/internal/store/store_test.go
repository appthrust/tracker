package store

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/pgstore/testutil"
	"github.com/lib/pq"
	"github.com/oklog/ulid/v2"
	"github.com/stretchr/testify/require"
)

func TestTranslate(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{{sql.ErrNoRows, 404}, {&pq.Error{Code: "23505"}, 409}, {&pq.Error{Code: "23503"}, 400}, {&pq.Error{Code: "23514"}, 400}} {
		var result *httpx.Error
		require.True(t, errors.As(translate(tc.err), &result))
		require.Equal(t, tc.status, result.Status)
	}
	original := errors.New("other")
	require.ErrorIs(t, translate(original), original)
}
func TestCursor(t *testing.T) {
	at := time.Now().UTC()
	id := ulid.Make().String()
	cursor := base64.RawURLEncoding.EncodeToString([]byte(at.Format(time.RFC3339Nano) + "|" + id))
	got, key, err := ParseCursor(cursor)
	require.NoError(t, err)
	require.True(t, at.Equal(got))
	require.Equal(t, id, key)
	for _, cursor := range []string{"bad", base64.RawURLEncoding.EncodeToString([]byte("bad|id")), base64.RawURLEncoding.EncodeToString([]byte(at.Format(time.RFC3339Nano) + "|bad"))} {
		_, _, err := ParseCursor(cursor)
		require.Error(t, err)
	}
}
func TestSeedOnlyEmptyAndStableCursorTies(t *testing.T) {
	database, _ := testutil.Database(t, Open)
	require.NoError(t, database.SeedDev(t.Context()))
	require.NoError(t, database.SeedDev(t.Context()))
	require.NoError(t, database.Do(t.Context(), true, func(tx *Tx) error {
		var count int
		require.NoError(t, tx.SQL.QueryRowContext(t.Context(), `SELECT count(*) FROM authors`).Scan(&count))
		require.Equal(t, 3, count)
		require.NoError(t, tx.Exec(`UPDATE articles SET published_at='2026-01-01T00:00:00Z' WHERE status='published'`))
		seen := map[string]bool{}
		cursor := ""
		for i := range 3 {
			page, err := tx.Timeline(TimelineOptions{Limit: 2, Cursor: cursor})
			require.NoError(t, err)
			require.Len(t, page.Items, 2)
			for _, a := range page.Items {
				require.False(t, seen[a.ID])
				seen[a.ID] = true
			}
			if i < 2 {
				require.NotNil(t, page.NextCursor)
				cursor = *page.NextCursor
			} else {
				require.Nil(t, page.NextCursor)
			}
		}
		return nil
	}))
}
