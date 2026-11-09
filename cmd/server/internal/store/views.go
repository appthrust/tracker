package store

import (
	"encoding/json"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

type ViewCreate struct {
	Name   string        `json:"name"`
	Layout string        `json:"layout"`
	Filter domain.Filter `json:"filter"`
	Sort   domain.Sort   `json:"sort"`
	Shared bool          `json:"shared"`
}
type ViewPatch struct {
	Name     *string        `json:"name"`
	Layout   *string        `json:"layout"`
	Filter   *domain.Filter `json:"filter"`
	Sort     *domain.Sort   `json:"sort"`
	Shared   *bool          `json:"shared"`
	Position *int           `json:"position"`
}

const viewColumns = `id,name,owner_sub,owner_name,shared,layout,filter,sort,position,created_at,updated_at`

func scanView(row scanner) (domain.View, error) {
	var item domain.View
	var filter []byte
	err := row.Scan(&item.ID, &item.Name, &item.Owner.Sub, &item.Owner.Name, &item.Shared, &item.Layout, &filter, &item.Sort, &item.Position, &item.CreatedAt, &item.UpdatedAt)
	if err == nil {
		err = json.Unmarshal(filter, &item.Filter)
	}
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}
func (t *Tx) Views(subject string) ([]domain.View, error) {
	items := []domain.View{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+viewColumns+` FROM tracker_view WHERE workspace_id=$1 AND (shared OR owner_sub=$2) ORDER BY position,id`, t.WorkspaceID, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanView(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (t *Tx) view(id string) (domain.View, error) {
	return scanView(t.SQL.QueryRowContext(t.Context, `SELECT `+viewColumns+` FROM tracker_view WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id))
}
func (t *Tx) CreateView(input ViewCreate, actor domain.Actor) (domain.View, error) {
	item := domain.View{ID: ulid.Make().String(), Name: strings.TrimSpace(input.Name), Owner: actor.Person, Shared: input.Shared, Layout: input.Layout, Filter: input.Filter, Sort: input.Sort}
	if !domain.Can(actor, domain.CreateView, domain.Target{Shared: item.Shared}) {
		return item, httpx.Forbidden()
	}
	if item.Layout == "" {
		item.Layout = "list"
	}
	if item.Sort == "" {
		item.Sort = domain.SortUpdated
	}
	if err := domain.ValidateView(item); err != nil {
		return item, invalid(err.Error())
	}
	var count int
	if err := t.SQL.QueryRowContext(t.Context, `SELECT count(*),coalesce(max(position),-1)+1 FROM tracker_view WHERE workspace_id=$1`, t.WorkspaceID).Scan(&count, &item.Position); err != nil {
		return item, err
	}
	if count >= 50 {
		return item, invalid("A workspace can have at most 50 views")
	}
	filter, err := jsonValue(item.Filter)
	if err != nil {
		return item, err
	}
	if err := t.Exec(`INSERT INTO tracker_view (id,workspace_id,name,owner_sub,owner_name,shared,layout,filter,sort,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, item.ID, t.WorkspaceID, item.Name, actor.Sub, actor.Name, item.Shared, item.Layout, filter, item.Sort, item.Position); err != nil {
		return item, err
	}
	return t.view(item.ID)
}
func (t *Tx) PatchView(id string, input ViewPatch, actor domain.Actor) (domain.View, error) {
	item, err := t.view(id)
	if err != nil {
		return item, err
	}
	if !domain.Can(actor, domain.ManageView, domain.Target{OwnerSub: item.Owner.Sub, Shared: item.Shared}) {
		return item, httpx.Forbidden()
	}
	if input.Name != nil {
		item.Name = strings.TrimSpace(*input.Name)
	}
	if input.Layout != nil {
		item.Layout = *input.Layout
	}
	if input.Filter != nil {
		item.Filter = *input.Filter
	}
	if input.Sort != nil {
		item.Sort = *input.Sort
	}
	if input.Shared != nil {
		if *input.Shared && actor.Role != "Admin" {
			return item, httpx.Forbidden()
		}
		item.Shared = *input.Shared
	}
	if input.Position != nil {
		if *input.Position < 0 {
			return item, invalid("Position must be nonnegative")
		}
		item.Position = *input.Position
	}
	if err := domain.ValidateView(item); err != nil {
		return item, invalid(err.Error())
	}
	filter, err := jsonValue(item.Filter)
	if err != nil {
		return item, err
	}
	if err := t.Exec(`UPDATE tracker_view SET name=$3,shared=$4,layout=$5,filter=$6,sort=$7,position=$8,updated_at=now() WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, item.ID, item.Name, item.Shared, item.Layout, filter, item.Sort, item.Position); err != nil {
		return item, err
	}
	return t.view(item.ID)
}
func (t *Tx) DeleteView(id string, actor domain.Actor) error {
	item, err := t.view(id)
	if err != nil {
		return err
	}
	if !domain.Can(actor, domain.ManageView, domain.Target{OwnerSub: item.Owner.Sub, Shared: item.Shared}) {
		return httpx.Forbidden()
	}
	return t.Exec(`DELETE FROM tracker_view WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, item.ID)
}
