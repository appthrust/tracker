-- One workspace per installation; id is PLATFORM_PROJECT_ID.
CREATE TABLE tracker_workspace (
  id          text PRIMARY KEY,
  key         text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,5}$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  issue_seq   bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
