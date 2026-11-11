package store

import (
	"encoding/json"

	"github.com/appthrust/tracker/cmd/server/internal/domain"
	"github.com/lib/pq"
)

const commentJSON = `jsonb_build_object('id',c.id,'issueId',c.issue_id,'author',jsonb_build_object('sub',c.author_sub,'name',c.author_name),'body',c.body,'createdAt',c.created_at,'editedAt',c.edited_at,
 'mentions',coalesce((SELECT jsonb_agg(jsonb_build_object('sub',m.target_sub,'name',a.name) ORDER BY a.handle) FROM tracker_mention m JOIN tracker_agent a ON m.target_sub='agent:'||a.id WHERE m.comment_id=c.id),'[]'::jsonb))`

func scanComment(row scanner) (domain.Comment, error) {
	var item domain.Comment
	var data []byte
	if err := row.Scan(&data); err != nil {
		return item, err
	}
	err := json.Unmarshal(data, &item)
	return item, err
}

func (t *Tx) syncMentions(commentID, body string) error {
	handles := domain.MentionHandles(body)
	if err := t.Exec(`DELETE FROM tracker_mention m WHERE comment_id=$1 AND NOT EXISTS(SELECT 1 FROM tracker_agent a WHERE a.workspace_id=$2 AND m.target_sub='agent:'||a.id AND a.handle=ANY($3))`, commentID, t.WorkspaceID, pq.Array(handles)); err != nil {
		return err
	}
	return t.Exec(`INSERT INTO tracker_mention(comment_id,target_sub) SELECT $1,'agent:'||a.id FROM tracker_agent a WHERE a.workspace_id=$2 AND a.handle=ANY($3) ON CONFLICT DO NOTHING`, commentID, t.WorkspaceID, pq.Array(handles))
}

func (t *Tx) inboxMentions(sub string) ([]domain.InboxItem, error) {
	rows, err := t.SQL.QueryContext(t.Context, `SELECT `+commentJSON+`,i.id,w.key||'-'||i.number,i.title,i.status_id FROM tracker_mention m JOIN tracker_comment c ON c.id=m.comment_id JOIN tracker_issue i ON i.id=c.issue_id JOIN tracker_workspace w ON w.id=i.workspace_id WHERE i.workspace_id=$1 AND m.target_sub=$2 AND m.acknowledged_at IS NULL AND c.deleted_at IS NULL AND i.deleted_at IS NULL ORDER BY c.created_at,c.id`, t.WorkspaceID, sub)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.InboxItem{}
	for rows.Next() {
		var data []byte
		var comment domain.Comment
		var issue domain.IssueSummary
		if err := rows.Scan(&data, &issue.ID, &issue.Identifier, &issue.Title, &issue.StatusID); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &comment); err != nil {
			return nil, err
		}
		items = append(items, domain.InboxItem{Kind: "mention", Comment: &comment, Issue: &issue})
	}
	return items, rows.Err()
}

type InboxAck struct {
	Answers  []string `json:"answers"`
	Mentions []string `json:"mentions"`
}

// Mention IDs are comment IDs; a caller has at most one mention per comment.
// Unknown IDs and other actors' IDs are ignored, making acknowledgement safe
// to retry without leaking another actor's inbox.
func (t *Tx) AckInbox(input InboxAck, actor domain.Actor) error {
	for _, ids := range [][]string{input.Answers, input.Mentions} {
		if len(ids) > 500 {
			return invalid("Acknowledge at most 500 items at a time")
		}
		for _, id := range ids {
			if !domain.ValidID(id) {
				return invalid("Acknowledgement IDs must be resource IDs")
			}
		}
	}
	if err := t.Exec(`UPDATE tracker_request q SET answer_acknowledged_at=$4 FROM tracker_issue i WHERE q.issue_id=i.id AND i.workspace_id=$1 AND q.from_sub=$2 AND q.id=ANY($3) AND q.state='answered' AND q.answer_acknowledged_at IS NULL`, t.WorkspaceID, actor.Sub, pq.Array(input.Answers), t.now()); err != nil {
		return err
	}
	return t.Exec(`UPDATE tracker_mention m SET acknowledged_at=$4 FROM tracker_comment c JOIN tracker_issue i ON i.id=c.issue_id WHERE m.comment_id=c.id AND i.workspace_id=$1 AND m.target_sub=$2 AND m.comment_id=ANY($3) AND m.acknowledged_at IS NULL`, t.WorkspaceID, actor.Sub, pq.Array(input.Mentions), t.now())
}
