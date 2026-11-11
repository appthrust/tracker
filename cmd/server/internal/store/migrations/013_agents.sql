-- Actor references preserve existing snapshots; credentials remain with the platform.
CREATE TABLE tracker_agent (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (handle ~ '^[a-z][a-z0-9-]{1,30}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 4096),
  owner_sub text NOT NULL CHECK (owner_sub NOT LIKE 'agent:%'),
  owner_name text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (workspace_id,handle)
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
  answer_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracker_request_issue ON tracker_request(issue_id,state);
CREATE INDEX tracker_request_run ON tracker_request(run_id,state);
ALTER TABLE tracker_issue ADD COLUMN delegator_sub text, ADD COLUMN delegator_name text;
ALTER TABLE tracker_workspace ADD COLUMN agent_completion text NOT NULL DEFAULT 'review' CHECK (agent_completion IN ('review','direct'));
ALTER TABLE tracker_workspace ADD COLUMN event_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE tracker_mention (
  comment_id text NOT NULL REFERENCES tracker_comment(id) ON DELETE CASCADE,
  target_sub text NOT NULL,
  acknowledged_at timestamptz,
  PRIMARY KEY (comment_id,target_sub)
);
CREATE INDEX tracker_mention_inbox ON tracker_mention(target_sub) WHERE acknowledged_at IS NULL;

CREATE TABLE tracker_event (
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  at timestamptz NOT NULL,
  issue jsonb,
  actor jsonb NOT NULL,
  type text NOT NULL CHECK (type IN ('issue.created','issue.updated','issue.deleted','comment.created','run.started','run.finished','run.canceled','request.opened','request.answered','request.withdrawn')),
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,seq)
);

CREATE TABLE tracker_idempotency (
  workspace_id text NOT NULL REFERENCES tracker_workspace(id) ON DELETE CASCADE,
  actor_sub text NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
  request_hash bytea NOT NULL,
  status integer NOT NULL,
  body bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,actor_sub,key)
);
CREATE INDEX tracker_idempotency_expiry ON tracker_idempotency(expires_at);
