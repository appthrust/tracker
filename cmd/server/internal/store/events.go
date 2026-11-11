package store

import (
	"encoding/json"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
)

// The workspace row stays locked through commit. Unlike a sequence, this cannot
// publish a higher cursor before a lower event or leave a gap after rollback.
func (t *Tx) event(issueID string, actor domain.Person, kind string, data any) error {
	var seq int64
	if err := t.SQL.QueryRowContext(t.Context, `UPDATE tracker_workspace SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq`, t.WorkspaceID).Scan(&seq); err != nil {
		return err
	}
	who, err := jsonValue(actor)
	if err != nil {
		return err
	}
	payload, err := jsonValue(data)
	if err != nil {
		return err
	}
	return t.Exec(`INSERT INTO tracker_event(workspace_id,seq,at,issue,actor,type,data)
 VALUES($1,$2,$3,(SELECT jsonb_build_object('id',i.id,'identifier',w.key||'-'||i.number,'title',i.title,'statusId',i.status_id) FROM tracker_issue i JOIN tracker_workspace w ON w.id=i.workspace_id WHERE i.workspace_id=$1 AND i.id=$4),$5,$6,$7)`, t.WorkspaceID, seq, t.now(), issueID, who, kind, payload)
}

type EventPage struct {
	Items []domain.Event `json:"items"`
	Next  int64          `json:"next"`
}

func (t *Tx) Events(after *int64, limit int) (EventPage, error) {
	page := EventPage{Items: []domain.Event{}}
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 500 || (after != nil && *after < 0) {
		return page, invalid("After must be nonnegative and limit must be between 1 and 500")
	}
	if after == nil {
		err := t.SQL.QueryRowContext(t.Context, `SELECT event_seq FROM tracker_workspace WHERE id=$1`, t.WorkspaceID).Scan(&page.Next)
		return page, err
	}
	page.Next = *after
	rows, err := t.SQL.QueryContext(t.Context, `SELECT seq,at,issue,actor,type,data FROM tracker_event WHERE workspace_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, t.WorkspaceID, *after, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var event domain.Event
		var issue, actor, data []byte
		if err := rows.Scan(&event.Seq, &event.At, &issue, &actor, &event.Type, &data); err != nil {
			return page, err
		}
		for _, field := range []struct {
			data []byte
			out  any
		}{{issue, &event.Issue}, {actor, &event.Actor}, {data, &event.Data}} {
			if len(field.data) > 0 {
				if err := json.Unmarshal(field.data, field.out); err != nil {
					return page, err
				}
			}
		}
		page.Items = append(page.Items, event)
		page.Next = event.Seq
	}
	return page, rows.Err()
}
