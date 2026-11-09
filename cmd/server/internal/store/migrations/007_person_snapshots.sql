-- Keep display-name snapshots when Directory is absent, as for issues/comments.
ALTER TABLE tracker_attachment ADD COLUMN uploader_name text NOT NULL DEFAULT '';
UPDATE tracker_attachment SET uploader_name = uploader_sub;
ALTER TABLE tracker_view ADD COLUMN owner_name text NOT NULL DEFAULT '';
UPDATE tracker_view SET owner_name = owner_sub;
