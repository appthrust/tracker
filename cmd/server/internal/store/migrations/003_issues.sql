CREATE TABLE tracker_issue (
  id               text PRIMARY KEY,                   -- ULID
  workspace_id     text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  number           bigint NOT NULL,                    -- stable; identifier = <key>-<number>
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 51200),
  type             text NOT NULL CHECK (type IN ('bug','feature','task')),
  priority         text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent','high','medium','low','none')),
  status_id        text NOT NULL REFERENCES tracker_status(id),
  assignee_sub     text,
  assignee_name    text,                                -- display snapshot at write time
  reporter_sub     text NOT NULL,
  reporter_name    text NOT NULL,
  parent_id        text REFERENCES tracker_issue(id) ON DELETE SET NULL,
  due_on           date,
  report           jsonb,                               -- present iff type = 'bug'
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  deleted_at       timestamptz,
  UNIQUE (workspace_id, number),
  CHECK ((type = 'bug') = (report IS NOT NULL))
);
CREATE INDEX tracker_issue_list ON tracker_issue (workspace_id, status_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tracker_issue_assignee ON tracker_issue (workspace_id, assignee_sub) WHERE deleted_at IS NULL;
CREATE INDEX tracker_issue_parent ON tracker_issue (parent_id);
CREATE INDEX tracker_issue_report ON tracker_issue USING gin (report jsonb_path_ops);
CREATE INDEX tracker_issue_search ON tracker_issue USING gin (to_tsvector('simple', title || ' ' || description));

CREATE TABLE tracker_issue_label (
  issue_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  label_id text NOT NULL REFERENCES tracker_label(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);

-- Directed: blocker blocks blocked. Stored once; read in both directions.
CREATE TABLE tracker_issue_block (
  blocker_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  blocked_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX tracker_issue_block_blocked ON tracker_issue_block (blocked_id);
