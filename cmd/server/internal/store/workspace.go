package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

// EnsureWorkspace creates the installation on first authenticated use. Existing
// workspaces use a read-only transaction; the write rechecks under pgstore's lock.
func (s *Store) EnsureWorkspace(ctx context.Context, id string) error {
	err := s.InWorkspace(ctx, id, false, func(tx *Tx) error { _, err := tx.Workspace(); return err })
	var response *httpx.Error
	if err == nil || !errors.As(err, &response) || response.Status != 404 {
		return err
	}
	return s.InWorkspace(ctx, id, true, func(tx *Tx) error { return tx.EnsureWorkspace() })
}
func (t *Tx) EnsureWorkspace() error {
	result, err := t.SQL.ExecContext(t.Context, `INSERT INTO tracker_workspace (id,key,name) VALUES ($1,'APT',$1) ON CONFLICT DO NOTHING`, t.WorkspaceID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	for _, status := range domain.DefaultStatuses() {
		if err := t.Exec(`INSERT INTO tracker_status (id,workspace_id,name,category,position,color) VALUES ($1,$2,$3,$4,$5,$6)`, ulid.Make().String(), t.WorkspaceID, status.Name, status.Category, status.Position, status.Color); err != nil {
			return err
		}
	}
	return nil
}
func (t *Tx) Workspace() (domain.Workspace, error) {
	var w domain.Workspace
	err := t.SQL.QueryRowContext(t.Context, `SELECT id,key,name,(SELECT count(*) FROM tracker_issue WHERE workspace_id=$1 AND deleted_at IS NULL),created_at,updated_at,sprint_length_weeks,timezone,agent_completion FROM tracker_workspace WHERE id=$1`, t.WorkspaceID).Scan(&w.ID, &w.Key, &w.Name, &w.IssueCount, &w.CreatedAt, &w.UpdatedAt, &w.SprintLengthWeeks, &w.Timezone, &w.AgentCompletion)
	return w, err
}
func (t *Tx) PatchWorkspace(key, name *string, lengthWeeks *int, timezone *string) (domain.Workspace, error) {
	w, err := t.Workspace()
	if err != nil {
		return w, err
	}
	if key != nil {
		w.Key = *key
	}
	if name != nil {
		w.Name = strings.TrimSpace(*name)
	}
	if lengthWeeks != nil {
		w.SprintLengthWeeks = *lengthWeeks
	}
	if timezone != nil {
		w.Timezone = *timezone
	}
	if w.SprintLengthWeeks != 1 && w.SprintLengthWeeks != 2 {
		return w, &domain.FieldError{Path: "sprintLengthWeeks", Message: "Sprint length must be 1 or 2 weeks"}
	}
	if _, err := time.LoadLocation(w.Timezone); err != nil || w.Timezone == "" || w.Timezone == "Local" {
		return w, &domain.FieldError{Path: "timezone", Message: "Timezone must be an IANA timezone name"}
	}
	if !domain.ValidKey(w.Key) || !domain.Text(w.Name, 1, 100) {
		return w, invalid("Workspace requires a key of 2 to 6 uppercase letters/digits and a name of 1 to 100 characters")
	}
	err = t.Exec(`UPDATE tracker_workspace SET key=$2,name=$3,sprint_length_weeks=$4,timezone=$5,updated_at=now() WHERE id=$1`, t.WorkspaceID, w.Key, w.Name, w.SprintLengthWeeks, w.Timezone)
	if err != nil {
		return w, err
	}
	return t.Workspace()
}
func (t *Tx) Statuses() ([]domain.Status, error) {
	items := []domain.Status{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,name,category,position,color FROM tracker_status WHERE workspace_id=$1 ORDER BY position,id`, t.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.Status
		if err := rows.Scan(&item.ID, &item.Name, &item.Category, &item.Position, &item.Color); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (t *Tx) Status(id string) (domain.Status, error) {
	var item domain.Status
	err := t.SQL.QueryRowContext(t.Context, `SELECT id,name,category,position,color FROM tracker_status WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id).Scan(&item.ID, &item.Name, &item.Category, &item.Position, &item.Color)
	return item, err
}
func validateNamed(name, color string) error {
	if !domain.Text(name, 1, 40) || !slices.Contains(domain.Colors, color) {
		return invalid("Name must contain 1 to 40 characters and color must be in the palette")
	}
	return nil
}
func (t *Tx) CreateStatus(name, category, color string) (domain.Status, error) {
	name = strings.TrimSpace(name)
	if color == "" {
		color = "gray"
	}
	if err := validateNamed(name, color); err != nil {
		return domain.Status{}, err
	}
	if !slices.Contains(domain.Categories, category) {
		return domain.Status{}, invalid("Invalid status category")
	}
	var position int
	if err := t.SQL.QueryRowContext(t.Context, `SELECT coalesce(max(position),-1)+1 FROM tracker_status WHERE workspace_id=$1 AND category=$2`, t.WorkspaceID, category).Scan(&position); err != nil {
		return domain.Status{}, err
	}
	if err := t.Exec(`UPDATE tracker_status SET position=position+1 WHERE workspace_id=$1 AND position >= $2`, t.WorkspaceID, position); err != nil {
		return domain.Status{}, err
	}
	id := ulid.Make().String()
	if err := t.Exec(`INSERT INTO tracker_status (id,workspace_id,name,category,position,color) VALUES ($1,$2,$3,$4,$5,$6)`, id, t.WorkspaceID, name, category, position, color); err != nil {
		return domain.Status{}, err
	}
	return t.Status(id)
}
func (t *Tx) PatchStatus(id string, name, color *string) (domain.Status, error) {
	item, err := t.Status(id)
	if err != nil {
		return item, err
	}
	if name != nil {
		item.Name = strings.TrimSpace(*name)
	}
	if color != nil {
		item.Color = *color
	}
	if err := validateNamed(item.Name, item.Color); err != nil {
		return item, err
	}
	if err := t.Exec(`UPDATE tracker_status SET name=$3,color=$4 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, item.Name, item.Color); err != nil {
		return item, err
	}
	return item, nil
}
func (t *Tx) DeleteStatus(id string) error {
	item, err := t.Status(id)
	if err != nil {
		return err
	}
	var used bool
	var count int
	if err := t.SQL.QueryRowContext(t.Context, `SELECT EXISTS(SELECT 1 FROM tracker_issue WHERE status_id=$1), (SELECT count(*) FROM tracker_status WHERE workspace_id=$2 AND category=$3)`, id, t.WorkspaceID, item.Category).Scan(&used, &count); err != nil {
		return err
	}
	if used || count <= 1 {
		return httpx.Conflict("Status is in use or is the last in its category")
	}
	return t.Exec(`DELETE FROM tracker_status WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id)
}
func (t *Tx) OrderStatuses(ids []string) ([]domain.Status, error) {
	items, err := t.Statuses()
	if err != nil {
		return nil, err
	}
	if len(ids) != len(items) {
		return nil, invalid("Order must include every status exactly once, grouped by category")
	}
	byID := make(map[string]domain.Status, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}
	last := -1
	for i, id := range ids {
		item, ok := byID[id]
		category := slices.Index(domain.Categories, item.Category)
		if !ok || category < last {
			return nil, invalid("Order must include every status exactly once, grouped by category")
		}
		delete(byID, id)
		last = category
		if err := t.Exec(`UPDATE tracker_status SET position=$3 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, i); err != nil {
			return nil, err
		}
	}
	return t.Statuses()
}
func (t *Tx) Labels() ([]domain.Label, error) {
	items := []domain.Label{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,name,color FROM tracker_label WHERE workspace_id=$1 ORDER BY name,id`, t.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.Label
		if err := rows.Scan(&item.ID, &item.Name, &item.Color); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (t *Tx) Label(id string) (domain.Label, error) {
	var item domain.Label
	err := t.SQL.QueryRowContext(t.Context, `SELECT id,name,color FROM tracker_label WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id).Scan(&item.ID, &item.Name, &item.Color)
	return item, err
}
func (t *Tx) CreateLabel(name, color string) (domain.Label, error) {
	name = strings.TrimSpace(name)
	if err := validateNamed(name, color); err != nil {
		return domain.Label{}, err
	}
	item := domain.Label{ID: ulid.Make().String(), Name: name, Color: color}
	return item, t.Exec(`INSERT INTO tracker_label (id,workspace_id,name,color) VALUES ($1,$2,$3,$4)`, item.ID, t.WorkspaceID, name, color)
}
func (t *Tx) PatchLabel(id string, name, color *string) (domain.Label, error) {
	item, err := t.Label(id)
	if err != nil {
		return item, err
	}
	if name != nil {
		item.Name = strings.TrimSpace(*name)
	}
	if color != nil {
		item.Color = *color
	}
	if err := validateNamed(item.Name, item.Color); err != nil {
		return item, err
	}
	return item, t.Exec(`UPDATE tracker_label SET name=$3,color=$4 WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, item.Name, item.Color)
}
func (t *Tx) DeleteLabel(id string) error {
	result, err := t.SQL.ExecContext(t.Context, `DELETE FROM tracker_label WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return sql.ErrNoRows
	}
	return err
}
