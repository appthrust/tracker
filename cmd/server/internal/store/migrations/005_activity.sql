-- Append-only field-change log; one row per changed field.
CREATE TABLE tracker_activity (
  id          text PRIMARY KEY,
  issue_id    text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  actor_sub   text NOT NULL,
  actor_name  text NOT NULL,
  field       text NOT NULL,          -- created|title|description|type|priority|status|assignee|labels|parent|blocks|due|report|attachment|deleted
  from_value  jsonb,
  to_value    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracker_activity_issue ON tracker_activity (issue_id, created_at);
