CREATE TABLE IF NOT EXISTS complaint_analysis_jobs (
  complaint_id uuid PRIMARY KEY REFERENCES complaints(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaint_analysis_jobs_complaint_workspace_fk
    FOREIGN KEY (complaint_id, workspace_id)
    REFERENCES complaints(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS complaint_analysis_jobs_queue_idx
  ON complaint_analysis_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS complaint_analysis_jobs_workspace_status_idx
  ON complaint_analysis_jobs(workspace_id, status);

-- Clean up any obsolete migration record for this migration sequence
DELETE FROM schema_migrations WHERE name = '011-complaint-workflow.sql';

-- Backfill already-analyzed complaints as completed
INSERT INTO complaint_analysis_jobs (complaint_id, workspace_id, status, attempt_count)
SELECT ca.complaint_id, c.workspace_id, 'completed', 1
FROM complaint_analyses ca
JOIN complaints c ON c.id = ca.complaint_id
ON CONFLICT (complaint_id) DO NOTHING;

-- Backfill unanalyzed complaints into the queue as pending
INSERT INTO complaint_analysis_jobs (complaint_id, workspace_id, status)
SELECT c.id, c.workspace_id, 'pending'
FROM complaints c
WHERE NOT EXISTS (SELECT 1 FROM complaint_analyses ca WHERE ca.complaint_id = c.id)
ON CONFLICT (complaint_id) DO NOTHING;

