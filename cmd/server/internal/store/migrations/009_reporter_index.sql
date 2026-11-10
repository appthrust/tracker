CREATE INDEX tracker_issue_reporter ON tracker_issue (workspace_id, reporter_sub) WHERE deleted_at IS NULL;
