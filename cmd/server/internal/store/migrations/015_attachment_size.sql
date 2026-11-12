-- Full-resolution screenshots did not fit in 2 MiB; domain.AttachmentMaxBytes is the same bound.
ALTER TABLE tracker_attachment DROP CONSTRAINT tracker_attachment_size_check,
  ADD CONSTRAINT tracker_attachment_size_check CHECK (size BETWEEN 1 AND 10485760);
