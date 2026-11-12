-- Subscriptions, plans, Razorpay payment transactions, monthly usage tracking, and webhook idempotency.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code IN ('starter', 'growth', 'business', 'enterprise')),
  name text NOT NULL,
  tagline text NOT NULL,
  target_audience text NOT NULL,
  monthly_price_paise integer CHECK (monthly_price_paise IS NULL OR monthly_price_paise >= 0),
  currency text NOT NULL DEFAULT 'INR',
  billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'custom')),
  monthly_complaint_limit integer CHECK (monthly_complaint_limit IS NULL OR monthly_complaint_limit > 0),
  max_workspaces integer CHECK (max_workspaces IS NULL OR max_workspaces > 0),
  is_popular boolean NOT NULL DEFAULT false,
  is_custom boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  gateway_plan_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  pending_plan_id uuid REFERENCES subscription_plans(id),
  status text NOT NULL CHECK (status IN ('created', 'payment_pending', 'active', 'past_due', 'cancelled', 'expired')),
  payment_provider text NOT NULL DEFAULT 'razorpay',
  provider_customer_id text,
  provider_subscription_id text UNIQUE,
  provider_plan_id text,
  custom_complaint_limit integer CHECK (custom_complaint_limit IS NULL OR custom_complaint_limit > 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  last_payment_at timestamptz,
  last_payment_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_subscriptions_status_idx
  ON workspace_subscriptions (status, current_period_end);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES workspace_subscriptions(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_payment_id text UNIQUE,
  provider_subscription_id text,
  provider_invoice_id text,
  amount_paise integer NOT NULL CHECK (amount_paise >= 0),
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),
  payment_method text,
  invoice_url text,
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_transactions_workspace_idx
  ON payment_transactions (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES workspace_subscriptions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_events_workspace_idx
  ON subscription_events (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monthly_usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_key text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  complaints_created integer NOT NULL DEFAULT 0 CHECK (complaints_created >= 0),
  last_complaint_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, period_key)
);

CREATE INDEX IF NOT EXISTS monthly_usage_records_lookup_idx
  ON monthly_usage_records (workspace_id, period_key);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'razorpay',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'processed',
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS enterprise_sales_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  phone text,
  expected_monthly_complaints text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (
  code, name, tagline, target_audience, monthly_price_paise, currency, billing_interval,
  monthly_complaint_limit, max_workspaces, is_popular, is_custom, is_active, display_order, features
)
VALUES
  (
    'starter',
    'Starter',
    'Essential AI complaint triage for small teams.',
    'Small businesses',
    99900,
    'INR',
    'monthly',
    500,
    1,
    false,
    false,
    true,
    1,
    '["1 workspace","Maximum 500 complaints per month","AI complaint classification","Complaint management dashboard","Basic reports","Standard support"]'::jsonb
  ),
  (
    'growth',
    'Growth',
    'Advanced analytics and team workflows for scaling support.',
    'Growing businesses',
    249900,
    'INR',
    'monthly',
    2500,
    3,
    true,
    false,
    true,
    2,
    '["Up to 2,500 complaints per month","Everything in Starter","Advanced analytics","Team access","Priority support"]'::jsonb
  ),
  (
    'business',
    'Business',
    'High-volume automation, multiple teams, and custom reporting.',
    'Larger businesses',
    599900,
    'INR',
    'monthly',
    10000,
    10,
    false,
    false,
    true,
    3,
    '["Up to 10,000 complaints per month","Everything in Growth","Advanced workflow options","Multiple teams","Custom reports"]'::jsonb
  ),
  (
    'enterprise',
    'Enterprise',
    'Tailored limits, integrations, and dedicated onboarding.',
    'Large organisations',
    NULL,
    'INR',
    'custom',
    NULL,
    NULL,
    false,
    true,
    true,
    4,
    '["Custom complaint limits","Custom integrations","Dedicated support","Custom workflows","Contact Sales option"]'::jsonb
  )
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  tagline = EXCLUDED.tagline,
  target_audience = EXCLUDED.target_audience,
  monthly_price_paise = EXCLUDED.monthly_price_paise,
  currency = EXCLUDED.currency,
  billing_interval = EXCLUDED.billing_interval,
  monthly_complaint_limit = EXCLUDED.monthly_complaint_limit,
  max_workspaces = EXCLUDED.max_workspaces,
  is_popular = EXCLUDED.is_popular,
  is_custom = EXCLUDED.is_custom,
  is_active = EXCLUDED.is_active,
  display_order = EXCLUDED.display_order,
  features = EXCLUDED.features,
  updated_at = now();
