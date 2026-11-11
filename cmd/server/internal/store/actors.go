package store

import (
	"strings"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/lib/pq"
)

// HydrateActors resolves all agent identities in one response in one query.
// Person snapshots are untouched, and no Directory call is made for a key.
func (t *Tx) HydrateActors(people []*domain.Person) error {
	byID := map[string][]*domain.Person{}
	ids := []string{}
	for _, person := range people {
		if person == nil || domain.ActorKind(person.Sub) != "agent" {
			continue
		}
		id := strings.TrimPrefix(person.Sub, "agent:")
		if _, found := byID[id]; !found {
			ids = append(ids, id)
		}
		byID[id] = append(byID[id], person)
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,handle,name,owner_sub,owner_name,disabled FROM tracker_agent WHERE workspace_id=$1 AND id=ANY($2)`, t.WorkspaceID, pq.Array(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a domain.Agent
		if err := rows.Scan(&a.ID, &a.Handle, &a.Name, &a.Owner.Sub, &a.Owner.Name, &a.Disabled); err != nil {
			return err
		}
		for _, person := range byID[a.ID] {
			*person = a.Person()
		}
	}
	return rows.Err()
}
