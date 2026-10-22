ALTER TABLE public_contact_forms DROP CONSTRAINT public_contact_forms_workspace_id_key;
ALTER TABLE public_contact_forms ADD COLUMN form_type text NOT NULL DEFAULT 'hosted'
  CHECK (form_type IN ('hosted', 'embed'));
ALTER TABLE public_contact_forms ADD COLUMN display_name text NOT NULL DEFAULT 'Tell us what happened'
  CHECK (char_length(display_name) BETWEEN 1 AND 100);
ALTER TABLE public_contact_forms ADD COLUMN fields jsonb NOT NULL DEFAULT
  '{"name":{"enabled":true,"required":true},"email":{"enabled":true,"required":true},"subject":{"enabled":true,"required":true},"description":{"enabled":true,"required":true},"category":{"enabled":true,"required":false}}'::jsonb
  CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 2000);
ALTER TABLE public_contact_forms ADD COLUMN allowed_origins text[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX public_contact_forms_workspace_hosted_idx
  ON public_contact_forms(workspace_id) WHERE form_type = 'hosted';
CREATE INDEX public_contact_forms_workspace_embed_idx
  ON public_contact_forms(workspace_id, created_at DESC) WHERE form_type = 'embed';
