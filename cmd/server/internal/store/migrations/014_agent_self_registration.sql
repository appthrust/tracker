-- Access Key name that self-registered the agent; NULL = registered by an Admin.
ALTER TABLE tracker_agent ADD COLUMN registered_key text CHECK (char_length(registered_key) BETWEEN 1 AND 253);
