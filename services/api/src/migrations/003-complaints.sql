CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  customer_email text CHECK (customer_email IS NULL OR char_length(customer_email) <= 254),
  source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX complaints_workspace_created_idx ON complaints(workspace_id, created_at DESC, id DESC);
CREATE INDEX complaints_workspace_status_created_idx ON complaints(workspace_id, status, created_at DESC, id DESC);
