-- Development PoC: identities use the existing snapshot columns, never credentials.
CREATE TABLE tracker_agent (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (handle ~ '^[a-z][a-z0-9-]{1,30}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 4096),
  key_subject text NOT NULL,
  owner_sub text NOT NULL CHECK (owner_sub NOT LIKE 'agent:%'),
  owner_name text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,handle),
  UNIQUE (workspace_id,key_subject)
);
CREATE TABLE tracker_run (
  id text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES tracker_agent(id),
  state text NOT NULL CHECK (state IN ('running','waiting','succeeded','failed','canceled')),
  reason text,
  session text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  links jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE UNIQUE INDEX tracker_run_active ON tracker_run(issue_id) WHERE state IN ('running','waiting');
CREATE INDEX tracker_run_agent ON tracker_run(agent_id);
CREATE TABLE tracker_request (
  id text PRIMARY KEY,
  issue_id text NOT NULL REFERENCES tracker_issue(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('question','approval','review')),
  from_sub text NOT NULL,
  from_name text NOT NULL,
  to_sub text,
  to_name text,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (octet_length(body) <= 20480),
  options jsonb NOT NULL DEFAULT '[]',
  run_id text REFERENCES tracker_run(id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered','withdrawn')),
  answer_option text,
  answer_body text,
  answered_by_sub text,
  answered_by_name text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracker_request_issue ON tracker_request(issue_id,state);
CREATE INDEX tracker_request_run ON tracker_request(run_id,state);
ALTER TABLE tracker_issue ADD COLUMN delegator_sub text, ADD COLUMN delegator_name text;
ALTER TABLE tracker_workspace ADD COLUMN agent_completion text NOT NULL DEFAULT 'review' CHECK (agent_completion IN ('review','direct'));
