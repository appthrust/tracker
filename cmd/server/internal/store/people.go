package store

import (
	"database/sql"
	"errors"
)

// KnownName returns the display name most recently recorded for a person by a
// signed-in write, or "" when this workspace has never seen one. Access Key
// requests carry no name, and their own writes record the subject as the name,
// so those rows are not a source.
func (t *Tx) KnownName(sub string) (string, error) {
	var name string
	err := t.SQL.QueryRowContext(t.Context, `SELECT a.actor_name FROM tracker_activity a JOIN tracker_issue i ON i.id=a.issue_id WHERE i.workspace_id=$1 AND a.actor_sub=$2 AND a.actor_name<>a.actor_sub ORDER BY a.created_at DESC LIMIT 1`, t.WorkspaceID, sub).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}
