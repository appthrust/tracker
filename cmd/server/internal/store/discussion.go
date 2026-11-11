package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/oklog/ulid/v2"
)

func validComment(body string) error {
	if strings.TrimSpace(body) == "" || !utf8.ValidString(body) || len(body) > 20<<10 {
		return invalid("Comment must contain 1 byte to 20 KiB of UTF-8 text")
	}
	return nil
}
func (t *Tx) touchIssue(id string) error {
	return t.Exec(`UPDATE tracker_issue SET updated_at=now() WHERE workspace_id=$1 AND id=$2`, t.WorkspaceID, id)
}
func (t *Tx) Comment(id string) (domain.Comment, error) {
	return scanComment(t.SQL.QueryRowContext(t.Context, `SELECT `+commentJSON+` FROM tracker_comment c JOIN tracker_issue i ON i.id=c.issue_id WHERE i.workspace_id=$1 AND c.id=$2 AND i.deleted_at IS NULL AND c.deleted_at IS NULL`, t.WorkspaceID, id))
}
func (t *Tx) CreateComment(issueID, body string, actor domain.Person) (domain.Comment, error) {
	if err := validComment(body); err != nil {
		return domain.Comment{}, err
	}
	issue, err := t.Issue(issueID)
	if err != nil {
		return domain.Comment{}, err
	}
	id := ulid.Make().String()
	if err := t.Exec(`INSERT INTO tracker_comment (id,issue_id,author_sub,author_name,body) VALUES ($1,$2,$3,$4,$5)`, id, issue.ID, actor.Sub, actor.Name, body); err != nil {
		return domain.Comment{}, err
	}
	if err := t.touchIssue(issue.ID); err != nil {
		return domain.Comment{}, err
	}
	if err := t.syncMentions(id, body); err != nil {
		return domain.Comment{}, err
	}
	if err := t.event(issue.ID, actor, "comment.created", id); err != nil {
		return domain.Comment{}, err
	}
	return t.Comment(id)
}
func (t *Tx) PatchComment(id, body string, actor domain.Actor) (domain.Comment, error) {
	c, err := t.Comment(id)
	if err != nil {
		return c, err
	}
	if !domain.Can(actor, domain.EditComment, domain.Target{OwnerSub: c.Author.Sub}) {
		return c, httpx.Forbidden()
	}
	if err := validComment(body); err != nil {
		return c, err
	}
	if body != c.Body {
		if err := t.Exec(`UPDATE tracker_comment SET body=$2,edited_at=now() WHERE id=$1`, c.ID, body); err != nil {
			return c, err
		}
		if err := t.syncMentions(c.ID, body); err != nil {
			return c, err
		}
		if err := t.touchIssue(c.IssueID); err != nil {
			return c, err
		}
	}
	return t.Comment(c.ID)
}
func (t *Tx) DeleteComment(id string, actor domain.Actor) error {
	c, err := t.Comment(id)
	if err != nil {
		return err
	}
	if !domain.Can(actor, domain.DeleteComment, domain.Target{OwnerSub: c.Author.Sub}) {
		return httpx.Forbidden()
	}
	if err := t.Exec(`UPDATE tracker_comment SET deleted_at=now() WHERE id=$1`, c.ID); err != nil {
		return err
	}
	return t.touchIssue(c.IssueID)
}
func (t *Tx) Attachment(id string, includeData bool) (domain.Attachment, []byte, error) {
	var a domain.Attachment
	var data []byte
	column := "NULL::bytea"
	if includeData {
		column = "a.data"
	}
	err := t.SQL.QueryRowContext(t.Context, `SELECT a.id,a.issue_id,a.filename,a.media_type,a.size,a.uploader_sub,a.uploader_name,a.created_at,`+column+` FROM tracker_attachment a JOIN tracker_issue i ON i.id=a.issue_id WHERE i.workspace_id=$1 AND a.id=$2 AND i.deleted_at IS NULL`, t.WorkspaceID, id).Scan(&a.ID, &a.IssueID, &a.Filename, &a.MediaType, &a.Size, &a.Uploader.Sub, &a.Uploader.Name, &a.CreatedAt, &data)
	a.URL = "/api/tracker/v1/attachments/" + a.ID
	a.CreatedAt = a.CreatedAt.UTC()
	return a, data, err
}
func (t *Tx) CreateAttachment(issueID, filename, mediaType string, data []byte, actor domain.Person) (domain.Attachment, error) {
	if err := domain.ValidateAttachment(filename, mediaType, len(data)); err != nil {
		return domain.Attachment{}, invalid(err.Error())
	}
	issue, err := t.Issue(issueID)
	if err != nil {
		return domain.Attachment{}, err
	}
	if issue.AttachmentCount >= 10 {
		return domain.Attachment{}, invalid("An issue can have at most 10 attachments")
	}
	id := ulid.Make().String()
	hash := sha256.Sum256(data)
	if err := t.Exec(`INSERT INTO tracker_attachment (id,issue_id,uploader_sub,uploader_name,filename,media_type,size,sha256,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, issue.ID, actor.Sub, actor.Name, filename, mediaType, len(data), hex.EncodeToString(hash[:]), data); err != nil {
		return domain.Attachment{}, err
	}
	a, _, err := t.Attachment(id, false)
	if err != nil {
		return a, err
	}
	if err := t.activity(issue.ID, actor, "attachment", nil, a); err != nil {
		return a, err
	}
	return a, t.touchIssue(issue.ID)
}
func (t *Tx) DeleteAttachment(id string, actor domain.Actor) error {
	a, _, err := t.Attachment(id, false)
	if err != nil {
		return err
	}
	if !domain.Can(actor, domain.DeleteAttachment, domain.Target{OwnerSub: a.Uploader.Sub}) {
		return httpx.Forbidden()
	}
	if err := t.Exec(`DELETE FROM tracker_attachment WHERE id=$1`, a.ID); err != nil {
		return err
	}
	if err := t.activity(a.IssueID, actor.Person, "attachment", a, nil); err != nil {
		return err
	}
	return t.touchIssue(a.IssueID)
}
func (t *Tx) Timeline(issueID string) ([]domain.TimelineItem, error) {
	issue, err := t.Issue(issueID)
	if err != nil {
		return nil, err
	}
	items := []domain.TimelineItem{}
	rows, err := t.SQL.QueryContext(t.Context, `SELECT id,actor_sub,actor_name,field,from_value,to_value,created_at FROM tracker_activity WHERE issue_id=$1 ORDER BY created_at,id`, issue.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		a := domain.Activity{IssueID: issue.ID}
		var from, to []byte
		if err := rows.Scan(&a.ID, &a.Actor.Sub, &a.Actor.Name, &a.Field, &from, &to, &a.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if len(from) > 0 {
			if err := json.Unmarshal(from, &a.From); err != nil {
				rows.Close()
				return nil, err
			}
		}
		if len(to) > 0 {
			if err := json.Unmarshal(to, &a.To); err != nil {
				rows.Close()
				return nil, err
			}
		}
		a.CreatedAt = a.CreatedAt.UTC()
		items = append(items, domain.TimelineItem{Kind: "activity", Activity: &a})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = t.SQL.QueryContext(t.Context, `SELECT `+commentJSON+` FROM tracker_comment c WHERE c.issue_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`, issue.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, domain.TimelineItem{Kind: "comment", Comment: &c})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	runs, err := t.Runs(issue.ID)
	if err != nil {
		return nil, err
	}
	for i := range runs {
		items = append(items, domain.TimelineItem{Kind: "run", Run: &runs[i]})
	}
	requests, err := t.Requests(RequestFilter{Issue: issue.ID})
	if err != nil {
		return nil, err
	}
	for i := range requests {
		items = append(items, domain.TimelineItem{Kind: "request", Request: &requests[i]})
	}
	key := func(item domain.TimelineItem) (time.Time, string) {
		if item.Activity != nil {
			return item.Activity.CreatedAt, item.Activity.ID
		}
		if item.Run != nil {
			return item.Run.StartedAt, item.Run.ID
		}
		if item.Request != nil {
			return item.Request.CreatedAt, item.Request.ID
		}
		return item.Comment.CreatedAt, item.Comment.ID
	}
	slices.SortFunc(items, func(a, b domain.TimelineItem) int {
		at, id := key(a)
		bt, bid := key(b)
		if c := at.Compare(bt); c != 0 {
			return c
		}
		return strings.Compare(id, bid)
	})
	return items, nil
}
