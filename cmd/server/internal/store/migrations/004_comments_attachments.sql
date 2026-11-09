CREATE TABLE tracker_comment (
  id           text PRIMARY KEY,
  issue_id     text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  author_sub   text NOT NULL,
  author_name  text NOT NULL,
  body         text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 20480),
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz,
  deleted_at   timestamptz
);
CREATE INDEX tracker_comment_issue ON tracker_comment (issue_id, created_at);

CREATE TABLE tracker_attachment (
  id            text PRIMARY KEY,
  issue_id      text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  uploader_sub  text NOT NULL,
  filename      text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  media_type    text NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp','text/plain','application/json')),
  size          integer NOT NULL CHECK (size BETWEEN 1 AND 2097152),
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracker_attachment_issue ON tracker_attachment (issue_id, created_at);
