CREATE TABLE tracker_status (
  id           text PRIMARY KEY,                       -- ULID
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  category     text NOT NULL CHECK (category IN ('backlog','unstarted','started','completed','canceled')),
  position     integer NOT NULL,
  color        text NOT NULL DEFAULT 'gray',
  UNIQUE (workspace_id, name)
);
CREATE INDEX tracker_status_order ON tracker_status (workspace_id, position);

CREATE TABLE tracker_label (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  color        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
