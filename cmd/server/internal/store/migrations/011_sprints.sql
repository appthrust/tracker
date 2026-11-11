-- Sprints, T-shirt-size estimates, and the sprint ledger (design/API.md "Sprints, estimates, burndown and velocity").
ALTER TABLE tracker_workspace ADD sprint_length_weeks int NOT NULL DEFAULT 1 CHECK (sprint_length_weeks IN (1,2)),
                              ADD timezone text NOT NULL DEFAULT 'Asia/Tokyo',
                              ADD sprint_seq bigint NOT NULL DEFAULT 0; -- sprint numbers stay monotonic when a planned sprint is deleted
CREATE TABLE tracker_sprint (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES tracker_workspace(id),
  number bigint NOT NULL, name text NOT NULL, goal text NOT NULL DEFAULT '',
  length_weeks int NOT NULL CHECK (length_weeks IN (1,2)), starts_on date NOT NULL, ends_on date NOT NULL,
  started_at timestamptz, closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number),
  CHECK (ends_on = starts_on + 7 * length_weeks - 1),
  CHECK (closed_at IS NULL OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX tracker_sprint_one_active ON tracker_sprint (workspace_id) WHERE started_at IS NOT NULL AND closed_at IS NULL;
ALTER TABLE tracker_issue ADD estimate text CHECK (estimate IN ('XS','S','M','L','XL')),
                          ADD sprint_id text REFERENCES tracker_sprint(id),
                          ADD CHECK (type <> 'epic' OR (estimate IS NULL AND sprint_id IS NULL));
CREATE INDEX tracker_issue_sprint ON tracker_issue (sprint_id) WHERE sprint_id IS NOT NULL;
CREATE TABLE tracker_sprint_event (
  id text PRIMARY KEY, sprint_id text NOT NULL REFERENCES tracker_sprint(id) ON DELETE CASCADE,
  issue_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE, at timestamptz NOT NULL DEFAULT now(),
  scope_points int NOT NULL, scope_issues int NOT NULL, done_points int NOT NULL, done_issues int NOT NULL
);
CREATE INDEX tracker_sprint_event_sprint ON tracker_sprint_event (sprint_id, at);
ALTER TABLE tracker_view DROP CONSTRAINT tracker_view_group_by_check;
ALTER TABLE tracker_view ADD CONSTRAINT tracker_view_group_by_check CHECK (group_by IN ('none','epic','story','sprint'));
