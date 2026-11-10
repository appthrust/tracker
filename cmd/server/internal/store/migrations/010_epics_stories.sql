-- Epics and stories reuse parent_id; only the type vocabulary grows.
-- The level rules (epic > story > work item) are enforced in domain code.
ALTER TABLE tracker_issue DROP CONSTRAINT tracker_issue_type_check;
ALTER TABLE tracker_issue ADD CONSTRAINT tracker_issue_type_check CHECK (type IN ('epic','story','bug','feature','task'));

ALTER TABLE tracker_view ADD COLUMN group_by text NOT NULL DEFAULT 'none' CHECK (group_by IN ('none','epic','story'));
