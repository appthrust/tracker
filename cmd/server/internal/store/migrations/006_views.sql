CREATE TABLE tracker_view (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  owner_sub    text NOT NULL,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  shared       boolean NOT NULL DEFAULT false,
  layout       text NOT NULL DEFAULT 'list' CHECK (layout IN ('list','board')),
  filter       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort         text NOT NULL DEFAULT 'updated',
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracker_view_ws ON tracker_view (workspace_id, shared, owner_sub);
