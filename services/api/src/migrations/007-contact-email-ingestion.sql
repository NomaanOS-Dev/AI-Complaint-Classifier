ALTER TABLE complaints DROP CONSTRAINT complaints_source_check;
ALTER TABLE complaints ADD CONSTRAINT complaints_source_check
  CHECK (source IN ('manual', 'contact_form', 'inbound_email'));
ALTER TABLE complaints ADD COLUMN customer_name text CHECK (customer_name IS NULL OR char_length(customer_name) <= 100);
ALTER TABLE complaints ADD COLUMN submitted_category text CHECK (submitted_category IS NULL OR char_length(submitted_category) <= 80);

CREATE TABLE public_contact_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  form_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(form_token_hash) = 32),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (id, workspace_id)
);
CREATE INDEX public_contact_forms_enabled_idx ON public_contact_forms(id) WHERE enabled AND revoked_at IS NULL;

CREATE TABLE public_contact_idempotency (
  form_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  complaint_id uuid NOT NULL,
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, idempotency_key),
  CONSTRAINT public_contact_idempotency_form_workspace_fk FOREIGN KEY (form_id, workspace_id)
    REFERENCES public_contact_forms(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT public_contact_idempotency_complaint_workspace_fk FOREIGN KEY (complaint_id, workspace_id)
    REFERENCES complaints(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX public_contact_idempotency_expiry_idx ON public_contact_idempotency(expires_at);

CREATE TABLE public_contact_rate_limits (
  form_id uuid NOT NULL REFERENCES public_contact_forms(id) ON DELETE CASCADE,
  client_hash bytea NOT NULL CHECK (octet_length(client_hash) = 32),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, client_hash)
);
CREATE TABLE workspace_contact_rate_limits (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_inbound_email_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  routing_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(routing_token_hash) = 32),
  recipient_hash bytea NOT NULL UNIQUE CHECK (octet_length(recipient_hash) = 32),
  recipient_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (id, workspace_id)
);
CREATE INDEX workspace_inbound_email_routes_enabled_idx ON workspace_inbound_email_routes(recipient_hash) WHERE enabled AND revoked_at IS NULL;

CREATE TABLE resend_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
  provider_email_id text NOT NULL UNIQUE CHECK (char_length(provider_email_id) BETWEEN 1 AND 200),
  provider_message_id text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  route_id uuid,
  recipient_hash bytea CHECK (recipient_hash IS NULL OR octet_length(recipient_hash) = 32),
  status text NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'duplicate', 'rejected', 'failed')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  complaint_id uuid,
  attachment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachment_metadata) = 'array' AND octet_length(attachment_metadata::text) <= 12000),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resend_inbound_route_workspace_fk FOREIGN KEY (route_id, workspace_id)
    REFERENCES workspace_inbound_email_routes(id, workspace_id) ON DELETE SET NULL (route_id),
  CONSTRAINT resend_inbound_complaint_workspace_fk FOREIGN KEY (complaint_id, workspace_id)
    REFERENCES complaints(id, workspace_id) ON DELETE SET NULL (complaint_id)
);
CREATE INDEX resend_inbound_queue_idx ON resend_inbound_events(next_attempt_at, received_at)
  WHERE status IN ('received', 'failed');
CREATE INDEX resend_inbound_workspace_idx ON resend_inbound_events(workspace_id, received_at DESC, id DESC);
CREATE UNIQUE INDEX resend_inbound_message_workspace_idx ON resend_inbound_events(workspace_id, provider_message_id)
  WHERE workspace_id IS NOT NULL AND provider_message_id IS NOT NULL;
