ALTER TABLE meta_social_connections
  ADD COLUMN access_token_ciphertext text,
  ADD COLUMN access_token_expires_at timestamptz,
  ADD COLUMN connected_at timestamptz,
  ADD COLUMN phone_display_number text,
  ADD COLUMN phone_verified_name text;

CREATE TABLE whatsapp_onboarding_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_onboarding_states_expiry_idx ON whatsapp_onboarding_states(expires_at);
