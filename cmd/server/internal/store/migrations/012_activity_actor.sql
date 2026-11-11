-- Access Key requests resolve the caller's display name from their latest signed-in write.
CREATE INDEX tracker_activity_actor ON tracker_activity (actor_sub, created_at DESC);
