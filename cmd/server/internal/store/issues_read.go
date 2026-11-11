package store

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/lib/pq"
)

const issueColumns = `i.id,w.key,i.number,i.title,i.type,i.priority,i.status_id,i.assignee_sub,i.assignee_name,i.reporter_sub,i.reporter_name,
	coalesce((SELECT array_agg(il.label_id ORDER BY il.label_id) FROM tracker_issue_label il WHERE il.issue_id=i.id),'{}'),
	(SELECT json_build_object('id',p.id,'identifier',w.key||'-'||p.number,'title',p.title,'statusId',p.status_id) FROM tracker_issue p WHERE p.id=i.parent_id AND p.workspace_id=i.workspace_id AND p.deleted_at IS NULL),
	to_char(i.due_on,'YYYY-MM-DD'),i.report,
	(SELECT count(*) FROM tracker_comment c WHERE c.issue_id=i.id AND c.deleted_at IS NULL),
	(SELECT count(*) FROM tracker_attachment a WHERE a.issue_id=i.id),i.created_at,i.updated_at,i.completed_at,i.project_id,
	lineage.epic,lineage.story,rollup.progress,i.estimate,
	(SELECT jsonb_build_object('id',sp.id,'number',sp.number,'name',sp.name,'state',CASE WHEN sp.closed_at IS NOT NULL THEN 'closed' WHEN sp.started_at IS NOT NULL THEN 'active' ELSE 'planned' END) FROM tracker_sprint sp WHERE sp.id=i.sprint_id),
	CASE WHEN i.delegator_sub IS NULL THEN NULL ELSE jsonb_build_object('sub',i.delegator_sub,'name',i.delegator_name) END,
	(SELECT ` + runJSON + ` FROM tracker_run r JOIN tracker_agent a ON a.id=r.agent_id WHERE r.issue_id=i.id AND r.state IN ('running','waiting')),
	(SELECT count(*) FROM tracker_request q WHERE q.issue_id=i.id AND q.state='open')`
const issueFrom = ` FROM tracker_issue i JOIN tracker_workspace w ON w.id=i.workspace_id JOIN tracker_status s ON s.id=i.status_id `

// Lateral recursive queries keep detail and list projections identical without
// issuing per-row database calls. Only the strict ancestor walk is depth-limited;
// progress includes work items at every depth.
const issueHierarchy = `
	LEFT JOIN LATERAL (
		WITH RECURSIVE ancestors AS (
			SELECT p.id,p.parent_id,p.number,p.title,p.status_id,p.type,1 AS depth
			FROM tracker_issue p
			WHERE p.workspace_id=i.workspace_id AND p.id=i.parent_id AND p.deleted_at IS NULL
			UNION ALL
			SELECT p.id,p.parent_id,p.number,p.title,p.status_id,p.type,a.depth+1
			FROM tracker_issue p JOIN ancestors a ON p.id=a.parent_id
			WHERE p.workspace_id=i.workspace_id AND p.deleted_at IS NULL AND a.depth<32
		)
		SELECT
			(SELECT jsonb_build_object('id',a.id,'identifier',w.key||'-'||a.number,'title',a.title,'statusId',a.status_id)
			 FROM ancestors a WHERE a.type='epic' ORDER BY a.depth LIMIT 1) AS epic,
			(SELECT jsonb_build_object('id',a.id,'identifier',w.key||'-'||a.number,'title',a.title,'statusId',a.status_id)
			 FROM ancestors a WHERE a.type='story' ORDER BY a.depth LIMIT 1) AS story
	) lineage ON true
	LEFT JOIN LATERAL (
		WITH RECURSIVE descendants AS (
			SELECT c.id,c.type,c.status_id,c.estimate FROM tracker_issue c
			WHERE i.type IN ('epic','story') AND c.workspace_id=i.workspace_id AND c.parent_id=i.id AND c.deleted_at IS NULL
			UNION
			SELECT c.id,c.type,c.status_id,c.estimate FROM tracker_issue c JOIN descendants d ON c.parent_id=d.id
			WHERE c.workspace_id=i.workspace_id AND c.deleted_at IS NULL
		)
		SELECT CASE WHEN i.type IN ('epic','story') THEN jsonb_build_object(
			'total',count(*) FILTER (WHERE s.category<>'canceled'),
			'completed',count(*) FILTER (WHERE s.category='completed'),
			'points',jsonb_build_object(
				'total',coalesce(sum(CASE d.estimate WHEN 'XS' THEN 1 WHEN 'S' THEN 2 WHEN 'M' THEN 3 WHEN 'L' THEN 5 WHEN 'XL' THEN 8 ELSE 0 END) FILTER (WHERE s.category<>'canceled'),0),
				'completed',coalesce(sum(CASE d.estimate WHEN 'XS' THEN 1 WHEN 'S' THEN 2 WHEN 'M' THEN 3 WHEN 'L' THEN 5 WHEN 'XL' THEN 8 ELSE 0 END) FILTER (WHERE s.category='completed'),0))) END AS progress
		FROM descendants d JOIN tracker_status s ON s.id=d.status_id
		WHERE d.type NOT IN ('epic','story')
	) rollup ON true `
const prioritySQL = `(CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END)`
const estimateSQL = `(CASE i.estimate WHEN 'XL' THEN 0 WHEN 'L' THEN 1 WHEN 'M' THEN 2 WHEN 'S' THEN 3 WHEN 'XS' THEN 4 ELSE 5 END)`

type scanner interface{ Scan(...any) error }

func scanIssue(row scanner, now time.Time) (domain.Issue, error) {
	var item domain.Issue
	var key string
	var sub, name, due sql.NullString
	var parent, report, epic, story, progress, sprint, delegator, activeRun []byte
	item.LabelIDs = []string{}
	item.Children = []domain.IssueRef{}
	item.Blocks = []domain.IssueRef{}
	item.BlockedBy = []domain.IssueRef{}
	err := row.Scan(&item.ID, &key, &item.Number, &item.Title, &item.Type, &item.Priority, &item.StatusID, &sub, &name, &item.Reporter.Sub, &item.Reporter.Name, pq.Array(&item.LabelIDs), &parent, &due, &report, &item.CommentCount, &item.AttachmentCount, &item.CreatedAt, &item.UpdatedAt, &item.CompletedAt, &item.ProjectID, &epic, &story, &progress, &item.Estimate, &sprint, &delegator, &activeRun, &item.OpenRequestCount, &item.Description)
	if err != nil {
		return item, err
	}
	item.Identifier = domain.FormatIdentifier(key, item.Number)
	if sub.Valid {
		item.Assignee = &domain.Person{Sub: sub.String, Name: name.String}
	}
	if due.Valid {
		item.DueOn = &due.String
	}
	for _, field := range []struct {
		data   []byte
		target any
	}{{parent, &item.Parent}, {report, &item.Report}, {epic, &item.Epic}, {story, &item.Story}, {progress, &item.Progress}, {sprint, &item.Sprint}, {delegator, &item.Delegator}, {activeRun, &item.ActiveRun}} {
		if len(field.data) > 0 {
			if err := json.Unmarshal(field.data, field.target); err != nil {
				return item, err
			}
		}
	}
	if item.ActiveRun != nil {
		item.ActiveRun.State = domain.RunState(item.ActiveRun.State, item.ActiveRun.LeaseExpiresAt, now)
	}
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	if item.CompletedAt != nil {
		at := item.CompletedAt.UTC()
		item.CompletedAt = &at
	}
	return item, nil
}
func (t *Tx) Issue(id string) (domain.Issue, error) {
	predicate := "i.id=$2"
	var value any = id
	if !domain.ValidID(id) {
		key, number, err := domain.ParseIdentifier(id)
		if err != nil {
			return domain.Issue{}, sql.ErrNoRows
		}
		workspace, err := t.Workspace()
		if err != nil {
			return domain.Issue{}, err
		}
		if key != workspace.Key {
			return domain.Issue{}, sql.ErrNoRows
		}
		predicate = "i.number=$2"
		value = number
	}
	item, err := scanIssue(t.SQL.QueryRowContext(t.Context, `SELECT `+issueColumns+`,i.description`+issueFrom+issueHierarchy+`WHERE i.workspace_id=$1 AND i.deleted_at IS NULL AND `+predicate, t.WorkspaceID, value), t.now())
	if err != nil {
		return item, err
	}
	item.Children, err = t.issueRefs(`i.parent_id=$2`, item.ID)
	if err != nil {
		return item, err
	}
	item.Blocks, err = t.issueRefs(`EXISTS(SELECT 1 FROM tracker_issue_block b WHERE b.blocker_id=$2 AND b.blocked_id=i.id)`, item.ID)
	if err != nil {
		return item, err
	}
	item.BlockedBy, err = t.issueRefs(`EXISTS(SELECT 1 FROM tracker_issue_block b WHERE b.blocked_id=$2 AND b.blocker_id=i.id)`, item.ID)
	return item, err
}
func (t *Tx) issueRefs(predicate, id string) ([]domain.IssueRef, error) {
	items := []domain.IssueRef{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT i.id,w.key||'-'||i.number,i.title,i.status_id`+issueFrom+`WHERE i.workspace_id=$1 AND i.deleted_at IS NULL AND `+predicate+` ORDER BY i.number`, t.WorkspaceID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.IssueRef
		if err := rows.Scan(&item.ID, &item.Identifier, &item.Title, &item.StatusID); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type ListOptions struct {
	Filter  domain.Filter
	Sort    domain.Sort
	Cursor  string
	Limit   int
	Subject string
}
type Page struct {
	Items      []domain.IssueSummary `json:"items"`
	NextCursor *string               `json:"nextCursor"`
}
type issueCursor struct {
	Sort     domain.Sort `json:"sort"`
	ID       string      `json:"id"`
	At       time.Time   `json:"at"`
	Number   int64       `json:"number"`
	Priority int         `json:"priority"`
	Estimate int         `json:"estimate"`
}

func parseCursor(raw string, sort domain.Sort) (issueCursor, error) {
	var cursor issueCursor
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Sort != sort || !domain.ValidID(cursor.ID) || cursor.At.IsZero() || cursor.Number < 1 || cursor.Priority < 0 || cursor.Priority > 4 || cursor.Estimate < 0 || cursor.Estimate > 5 {
		return cursor, invalid("Invalid cursor")
	}
	return cursor, nil
}
func (t *Tx) ListIssues(options ListOptions) (Page, error) {
	page := Page{Items: []domain.IssueSummary{}}
	if options.Limit == 0 {
		options.Limit = 50
	}
	if options.Sort == "" {
		options.Sort = domain.SortUpdated
	}
	if options.Limit < 1 || options.Limit > 200 || !domain.ValidSort(options.Sort) {
		return page, invalid("Invalid limit or sort")
	}
	if err := domain.ValidateFilter(options.Filter); err != nil {
		if _, ok := err.(*domain.FieldError); ok {
			return page, err
		}
		return page, invalid(err.Error())
	}
	args := []any{t.WorkspaceID}
	clauses := []string{"i.workspace_id=$1", "i.deleted_at IS NULL"}
	bind := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	anyOf := func(column string, values []string) {
		if len(values) > 0 {
			clauses = append(clauses, column+" = ANY("+bind(pq.Array(values))+")")
		}
	}
	f := options.Filter
	anyOf("i.status_id", f.Status)
	anyOf("s.category", f.Category)
	anyOf("i.type", f.Type)
	anyOf("i.priority", f.Priority)
	anyOf("i.report->>'environment'", f.Environment)
	anyOf("i.report->>'surface'", f.Surface)
	if len(f.Label) > 0 {
		clauses = append(clauses, "EXISTS(SELECT 1 FROM tracker_issue_label il WHERE il.issue_id=i.id AND il.label_id=ANY("+bind(pq.Array(f.Label))+"))")
	}
	if len(f.Assignee) > 0 {
		values := make([]string, 0, len(f.Assignee))
		none := false
		for _, sub := range f.Assignee {
			switch sub {
			case "none":
				none = true
			case "me":
				values = append(values, options.Subject)
			default:
				values = append(values, sub)
			}
		}
		condition := "i.assignee_sub=ANY(" + bind(pq.Array(values)) + ")"
		if none {
			condition += " OR i.assignee_sub IS NULL"
		}
		clauses = append(clauses, "("+condition+")")
	}
	reporters := f.Reporter
	if slices.Contains(reporters, "me") {
		reporters = slices.Clone(reporters)
		for i, sub := range reporters {
			if sub == "me" {
				reporters[i] = options.Subject
			}
		}
	}
	anyOf("i.reporter_sub", reporters)
	if len(f.Project) > 0 {
		condition := "i.project_id=ANY(" + bind(pq.Array(f.Project)) + ")"
		if slices.Contains(f.Project, "none") {
			condition += " OR i.project_id IS NULL"
		}
		clauses = append(clauses, "("+condition+")")
	}
	if len(f.Sprint) > 0 {
		condition := "i.sprint_id=ANY(" + bind(pq.Array(f.Sprint)) + ")"
		if slices.Contains(f.Sprint, "none") {
			condition += " OR i.sprint_id IS NULL"
		}
		if slices.Contains(f.Sprint, "active") {
			condition += " OR i.sprint_id IN (SELECT id FROM tracker_sprint WHERE workspace_id=i.workspace_id AND started_at IS NOT NULL AND closed_at IS NULL)"
		}
		clauses = append(clauses, "("+condition+")")
	}
	for _, field := range []struct {
		column string
		values []string
	}{{"lineage.epic", f.Epic}, {"lineage.story", f.Story}} {
		if len(field.values) > 0 {
			condition := field.column + "->>'id'=ANY(" + bind(pq.Array(field.values)) + ")"
			if slices.Contains(field.values, "none") {
				condition += " OR " + field.column + " IS NULL"
			}
			clauses = append(clauses, "("+condition+")")
		}
	}
	if f.Q != "" {
		value := bind(f.Q)
		clauses = append(clauses, "(strpos(lower(i.title),lower("+value+"))>0 OR strpos(lower(i.description),lower("+value+"))>0)")
	}
	if f.CreatedAfter != "" {
		clauses = append(clauses, "i.created_at>"+bind(f.CreatedAfter)+"::timestamptz")
	}
	if f.Parent == "none" {
		clauses = append(clauses, "i.parent_id IS NULL")
	} else if f.Parent != "" {
		clauses = append(clauses, "i.parent_id="+bind(f.Parent))
	}
	order := "i.updated_at DESC,i.id DESC"
	switch options.Sort {
	case domain.SortCreated:
		order = "i.created_at DESC,i.id DESC"
	case domain.SortPriority:
		order = prioritySQL + " ASC,i.updated_at DESC,i.id DESC"
	case domain.SortNumber:
		order = "i.number ASC,i.id ASC"
	case domain.SortEstimate:
		order = estimateSQL + " ASC,i.updated_at DESC,i.id DESC"
	}
	if options.Cursor != "" {
		c, err := parseCursor(options.Cursor, options.Sort)
		if err != nil {
			return page, err
		}
		switch options.Sort {
		case domain.SortNumber:
			clauses = append(clauses, "(i.number,i.id)>("+bind(c.Number)+","+bind(c.ID)+")")
		case domain.SortPriority:
			p, at, id := bind(c.Priority), bind(c.At), bind(c.ID)
			clauses = append(clauses, "("+prioritySQL+">"+p+" OR ("+prioritySQL+"="+p+" AND (i.updated_at,i.id)<("+at+","+id+")))")
		case domain.SortEstimate:
			size, at, id := bind(c.Estimate), bind(c.At), bind(c.ID)
			clauses = append(clauses, "("+estimateSQL+">"+size+" OR ("+estimateSQL+"="+size+" AND (i.updated_at,i.id)<("+at+","+id+")))")
		default:
			column := "i.updated_at"
			if options.Sort == domain.SortCreated {
				column = "i.created_at"
			}
			clauses = append(clauses, "("+column+",i.id)<("+bind(c.At)+","+bind(c.ID)+")")
		}
	}
	query := `SELECT ` + issueColumns + `,''` + issueFrom + issueHierarchy + `WHERE ` + strings.Join(clauses, " AND ") + ` ORDER BY ` + order + ` LIMIT ` + bind(options.Limit+1)
	rows, err := t.SQL.QueryContext(t.Context, query, args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	now := t.now()
	for rows.Next() {
		item, err := scanIssue(rows, now)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, item.IssueSummary)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > options.Limit {
		page.Items = page.Items[:options.Limit]
		last := page.Items[len(page.Items)-1]
		at := last.UpdatedAt
		if options.Sort == domain.SortCreated {
			at = last.CreatedAt
		}
		priority := 4
		for i, value := range domain.Priorities {
			if value == last.Priority {
				priority = i
				break
			}
		}
		estimate := 5
		if last.Estimate != nil {
			estimate = slices.Index([]string{"XL", "L", "M", "S", "XS"}, *last.Estimate)
		}
		data, err := json.Marshal(issueCursor{Sort: options.Sort, ID: last.ID, At: at, Number: last.Number, Priority: priority, Estimate: estimate})
		if err != nil {
			return page, err
		}
		cursor := base64.RawURLEncoding.EncodeToString(data)
		page.NextCursor = &cursor
	}
	return page, nil
}
