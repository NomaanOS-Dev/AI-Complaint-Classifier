ALTER TABLE complaints
  ADD CONSTRAINT complaints_id_workspace_unique UNIQUE (id, workspace_id);

CREATE TABLE complaint_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('complaint_created', 'status_changed', 'analysis_completed')),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT complaint_activity_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 2048
  ),
  CONSTRAINT complaint_activity_complaint_workspace_fk
    FOREIGN KEY (complaint_id, workspace_id)
    REFERENCES complaints(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX complaint_activity_timeline_idx
  ON complaint_activity_events(workspace_id, complaint_id, occurred_at, id);

CREATE INDEX complaint_activity_actor_idx
  ON complaint_activity_events(actor_user_id, occurred_at DESC);

CREATE FUNCTION reject_complaint_activity_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'complaint activity events are append-only';
END;
$$;

CREATE TRIGGER complaint_activity_no_update
  BEFORE UPDATE ON complaint_activity_events
  FOR EACH ROW EXECUTE FUNCTION reject_complaint_activity_update();
