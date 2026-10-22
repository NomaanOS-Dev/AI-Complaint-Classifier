CREATE TABLE workspace_integrations (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  requests_per_minute integer NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  key_prefix text NOT NULL UNIQUE,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  rotated_to uuid REFERENCES integration_credentials(id) ON DELETE SET NULL
);
ALTER TABLE integration_credentials ADD CONSTRAINT integration_credentials_id_workspace_unique UNIQUE (id, workspace_id);
CREATE INDEX integration_credentials_workspace_idx ON integration_credentials(workspace_id, created_at DESC);

CREATE TABLE workspace_integration_rate_limits (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_auth_rate_limits (
  ip_hash bytea PRIMARY KEY CHECK (octet_length(ip_hash) = 32),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  payload_hash char(64) NOT NULL,
  complaint_id uuid NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  UNIQUE (workspace_id, credential_id, idempotency_key),
  FOREIGN KEY (credential_id, workspace_id) REFERENCES integration_credentials(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (complaint_id, workspace_id) REFERENCES complaints(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX integration_idempotency_expiry_idx ON integration_idempotency(expires_at);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0 AND event_types <@ ARRAY['complaint_created', 'status_changed', 'analysis_completed']::text[]),
  signing_secret_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX webhook_endpoints_workspace_idx ON webhook_endpoints(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_id_workspace_unique UNIQUE (id, workspace_id);
ALTER TABLE complaint_activity_events ADD CONSTRAINT complaint_activity_id_workspace_unique UNIQUE (id, workspace_id);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  total_attempt_count integer NOT NULL DEFAULT 0 CHECK (total_attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  delivered_at timestamptz,
  last_attempt_at timestamptz,
  last_http_status integer,
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id),
  FOREIGN KEY (endpoint_id, workspace_id) REFERENCES webhook_endpoints(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, workspace_id) REFERENCES complaint_activity_events(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(next_attempt_at, created_at) WHERE state = 'pending';
CREATE INDEX webhook_deliveries_workspace_idx ON webhook_deliveries(workspace_id, created_at DESC, id DESC);

CREATE TABLE webhook_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  outcome text NOT NULL CHECK (outcome IN ('in_progress', 'delivered', 'retryable_failure', 'permanent_failure', 'worker_interrupted')),
  response_summary text CHECK (response_summary IS NULL OR char_length(response_summary) <= 160),
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX webhook_attempts_delivery_idx ON webhook_delivery_attempts(delivery_id, attempt_number DESC);
