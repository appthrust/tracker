package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

type ProjectCreate struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Color       *string `json:"color"`
}

type ProjectPatch struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
	Archived    *bool   `json:"archived"`
}

const projectSelect = `SELECT p.id,p.name,p.description,p.color,p.archived_at IS NOT NULL,
	count(i.id),count(i.id) FILTER (WHERE s.category NOT IN ('completed','canceled')),p.created_at,p.updated_at
	FROM tracker_project p
	LEFT JOIN tracker_issue i ON i.project_id=p.id AND i.workspace_id=p.workspace_id AND i.deleted_at IS NULL
	LEFT JOIN tracker_status s ON s.id=i.status_id `

func scanProject(row scanner) (domain.Project, error) {
	var item domain.Project
	err := row.Scan(&item.ID, &item.Name, &item.Description, &item.Color, &item.Archived, &item.IssueCount, &item.OpenIssueCount, &item.CreatedAt, &item.UpdatedAt)
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func (t *Tx) Projects(includeArchived bool) ([]domain.Project, error) {
	items := []domain.Project{}
	rows, err := t.SQL.QueryContext(t.Context, projectSelect+`WHERE p.workspace_id=$1 AND ($2 OR p.archived_at IS NULL) GROUP BY p.id ORDER BY p.name,p.id`, t.WorkspaceID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (t *Tx) Project(id string) (domain.Project, error) {
	return scanProject(t.SQL.QueryRowContext(t.Context, projectSelect+`WHERE p.workspace_id=$1 AND p.id=$2 GROUP BY p.id`, t.WorkspaceID, id))
}

func (t *Tx) CreateProject(input ProjectCreate, actor domain.Actor) (domain.Project, error) {
	item := domain.Project{ID: ulid.Make().String(), Name: strings.TrimSpace(input.Name), Description: input.Description, Color: "gray"}
	if !domain.Can(actor, domain.CreateProject, domain.Target{}) {
		return item, httpx.Forbidden()
	}
	if input.Color != nil {
		item.Color = *input.Color
	}
	if err := domain.ValidateProject(item); err != nil {
		return item, invalid(err.Error())
	}
	if err := t.Exec(`INSERT INTO tracker_project (id,workspace_id,name,description,color) VALUES ($1,$2,$3,$4,$5)`, item.ID, t.WorkspaceID, item.Name, item.Description, item.Color); err != nil {
		return item, err
	}
	return t.Project(item.ID)
}

func (t *Tx) PatchProject(id string, input ProjectPatch, actor domain.Actor) (domain.Project, error) {
	if !domain.Can(actor, domain.EditProject, domain.Target{}) || (input.Archived != nil && !domain.Can(actor, domain.ArchiveProject, domain.Target{})) {
		return domain.Project{}, httpx.Forbidden()
	}
	item, err := t.Project(id)
	if err != nil {
		return item, err
	}
	if input.Name != nil {
		item.Name = strings.TrimSpace(*input.Name)
	}
	if input.Description != nil {
		item.Description = *input.Description
	}
	if input.Color != nil {
		item.Color = *input.Color
	}
	if input.Archived != nil {
		item.Archived = *input.Archived
	}
	if err := domain.ValidateProject(item); err != nil {
		return item, invalid(err.Error())
	}
	if err := t.Exec(`UPDATE tracker_project SET name=$3,description=$4,color=$5,archived_at=CASE WHEN $6 THEN coalesce(archived_at,now()) ELSE NULL END,updated_at=now() WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id, item.Name, item.Description, item.Color, item.Archived); err != nil {
		return item, err
	}
	return t.Project(id)
}

func (t *Tx) DeleteProject(id string, actor domain.Actor) error {
	if !domain.Can(actor, domain.DeleteProject, domain.Target{}) {
		return httpx.Forbidden()
	}
	item, err := t.Project(id)
	if err != nil {
		return err
	}
	if item.IssueCount > 0 {
		return httpx.Conflict("Project has issues; archive it instead")
	}
	// Soft-deleted issues must not prevent deletion under the RESTRICT foreign key.
	// Their historical project activity remains intact.
	if err := t.Exec(`UPDATE tracker_issue SET project_id=NULL WHERE workspace_id=$1 AND project_id=$2 AND deleted_at IS NOT NULL`, t.WorkspaceID, id); err != nil {
		return err
	}
	return t.Exec(`DELETE FROM tracker_project WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id)
}

func (t *Tx) validateProjectAssignment(id *string) error {
	if id == nil {
		return nil
	}
	var archived bool
	err := t.SQL.QueryRowContext(t.Context, `SELECT archived_at IS NOT NULL FROM tracker_project WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, *id).Scan(&archived)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && archived) {
		return &domain.FieldError{Path: "projectId", Message: "Project must be active and belong to this workspace"}
	}
	return err
}
