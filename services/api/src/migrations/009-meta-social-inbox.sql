ALTER TABLE complaints DROP CONSTRAINT complaints_source_check;
ALTER TABLE complaints ADD CONSTRAINT complaints_source_check
  CHECK (source IN ('manual', 'contact_form', 'inbound_email', 'whatsapp', 'instagram'));

ALTER TABLE complaint_activity_events DROP CONSTRAINT complaint_activity_events_event_type_check;
ALTER TABLE complaint_activity_events ADD CONSTRAINT complaint_activity_events_event_type_check
  CHECK (event_type IN ('complaint_created', 'status_changed', 'analysis_completed', 'social_message_received'));

CREATE TABLE meta_social_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('whatsapp', 'instagram')),
  provider_account_id text NOT NULL CHECK (char_length(provider_account_id) BETWEEN 1 AND 200),
  business_account_id text CHECK (business_account_id IS NULL OR char_length(business_account_id) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disconnected')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_successful_event_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
  UNIQUE (provider, provider_account_id),
  UNIQUE (id, workspace_id)
);
CREATE INDEX meta_social_connections_workspace_idx
  ON meta_social_connections(workspace_id, provider, created_at DESC);

CREATE TABLE meta_social_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('whatsapp', 'instagram')),
  external_event_id text NOT NULL CHECK (char_length(external_event_id) BETWEEN 1 AND 200),
  connection_id uuid,
  workspace_id uuid,
  status text NOT NULL CHECK (status IN ('processed', 'rejected')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, external_event_id),
  CHECK ((connection_id IS NULL) = (workspace_id IS NULL)),
  FOREIGN KEY (connection_id, workspace_id)
    REFERENCES meta_social_connections(id, workspace_id) ON DELETE SET NULL (connection_id, workspace_id)
);
CREATE INDEX meta_social_events_connection_idx
  ON meta_social_events(connection_id, received_at DESC);

CREATE TABLE meta_social_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_conversation_id text NOT NULL CHECK (char_length(external_conversation_id) BETWEEN 1 AND 220),
  external_sender_id text NOT NULL CHECK (char_length(external_sender_id) BETWEEN 1 AND 200),
  complaint_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_conversation_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (connection_id, workspace_id)
    REFERENCES meta_social_connections(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (complaint_id, workspace_id)
    REFERENCES complaints(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX meta_social_conversations_complaint_idx
  ON meta_social_conversations(workspace_id, complaint_id);

CREATE TABLE meta_social_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activity_event_id uuid NOT NULL UNIQUE,
  external_message_id text NOT NULL CHECK (char_length(external_message_id) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  attachment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachment_metadata) = 'array' AND octet_length(attachment_metadata::text) <= 2000),
  provider_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_message_id),
  FOREIGN KEY (connection_id, workspace_id)
    REFERENCES meta_social_connections(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES meta_social_conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (activity_event_id, workspace_id)
    REFERENCES complaint_activity_events(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX meta_social_messages_conversation_idx
  ON meta_social_messages(workspace_id, conversation_id, created_at, id);
