-- Projects group issues inside a workspace (product area / workstream).
-- An issue belongs to at most one project.
CREATE TABLE tracker_project (
  id           text PRIMARY KEY,                       -- ULID
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description  text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 4096),
  color        text NOT NULL DEFAULT 'gray',
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- RESTRICT: a project with issues is archived, not deleted.
ALTER TABLE tracker_issue ADD COLUMN project_id text REFERENCES tracker_project(id) ON DELETE RESTRICT;
CREATE INDEX tracker_issue_project ON tracker_issue (workspace_id, project_id) WHERE deleted_at IS NULL;
