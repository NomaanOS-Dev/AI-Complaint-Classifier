import { createHash } from "node:crypto";
import type pg from "pg";
import type { RazorpayGateway, RazorpaySubscription } from "./razorpay-client.js";

export type SubscriptionPlanRow = {
  id: string;
  code: "starter" | "growth" | "business" | "enterprise";
  name: string;
  tagline: string;
  target_audience: string;
  monthly_price_paise: number | null;
  currency: string;
  billing_interval: "monthly" | "custom";
  monthly_complaint_limit: number | null;
  max_workspaces: number | null;
  is_popular: boolean;
  is_custom: boolean;
  is_active: boolean;
  display_order: number;
  features: string[];
  gateway_plan_id: string | null;
};

export type WorkspaceSubscriptionStatus =
  | "created"
  | "payment_pending"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

export type WorkspaceSubscriptionRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  pending_plan_id: string | null;
  status: WorkspaceSubscriptionStatus;
  payment_provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  provider_plan_id: string | null;
  custom_complaint_limit: number | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  last_payment_at: string | null;
  last_payment_error: string | null;
  created_at: string;
  updated_at: string;
};

export type UsageSummary = {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  complaintsUsed: number;
  monthlyLimit: number | null;
  remaining: number | null;
  percentUsed: number;
  nearLimit: boolean;
  limitReached: boolean;
};

export type BillingAccessCheck =
  | { allowed: true; usage: UsageSummary }
  | {
      allowed: false;
      statusCode: 402 | 429;
      code:
        | "SUBSCRIPTION_REQUIRED"
        | "PAYMENT_PENDING"
        | "SUBSCRIPTION_INACTIVE"
        | "SUBSCRIPTION_EXPIRED"
        | "USAGE_LIMIT_REACHED";
      error: string;
      upgradeUrl: string;
      usage?: UsageSummary;
    };

export class BillingError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "BILLING_ERROR") {
    super(message);
    this.name = "BillingError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function getCurrentBillingPeriod(now = new Date()): {
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { periodKey, periodStart, periodEnd };
}

export function buildUsageSummary(
  complaintsUsed: number,
  monthlyLimit: number | null,
  period: { periodKey: string; periodStart: Date; periodEnd: Date }
): UsageSummary {
  const remaining = monthlyLimit === null ? null : Math.max(0, monthlyLimit - complaintsUsed);
  const percentUsed =
    monthlyLimit === null || monthlyLimit <= 0
      ? 0
      : Math.min(100, Math.round((complaintsUsed / monthlyLimit) * 100));
  const nearLimit = monthlyLimit !== null && percentUsed >= 80 && complaintsUsed < monthlyLimit;
  const limitReached = monthlyLimit !== null && complaintsUsed >= monthlyLimit;

  return {
    periodKey: period.periodKey,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    complaintsUsed,
    monthlyLimit,
    remaining,
    percentUsed,
    nearLimit,
    limitReached
  };
}

function envPlanIdForCode(code: string): string | null {
  const map: Record<string, string | undefined> = {
    starter: process.env.RAZORPAY_PLAN_STARTER_ID,
    growth: process.env.RAZORPAY_PLAN_GROWTH_ID,
    business: process.env.RAZORPAY_PLAN_BUSINESS_ID
  };
  const val = map[code];
  if (!val || val.trim().length === 0 || val.trim().startsWith("replace-with-")) return null;
  return val.trim();
}

function unixSecondsToDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function addOneMonth(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function evaluateSubscriptionAccess(
  subscription: {
    status: WorkspaceSubscriptionStatus;
    current_period_end: string | Date | null;
  } | null,
  now = new Date()
): { allowed: true } | { allowed: false; code: "SUBSCRIPTION_REQUIRED" | "PAYMENT_PENDING" | "SUBSCRIPTION_INACTIVE" | "SUBSCRIPTION_EXPIRED"; error: string } {
  if (!subscription) {
    return {
      allowed: false,
      code: "SUBSCRIPTION_REQUIRED",
      error: "An active subscription plan is required to create complaints. Choose a plan to continue."
    };
  }

  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;

  if (subscription.status === "created" || subscription.status === "payment_pending") {
    return {
      allowed: false,
      code: "PAYMENT_PENDING",
      error: "Complete your subscription payment to activate complaint intake for this workspace."
    };
  }

  if (subscription.status === "past_due" || subscription.status === "expired") {
    return {
      allowed: false,
      code: "SUBSCRIPTION_INACTIVE",
      error: "Your workspace subscription is past due or expired. Update billing to restore complaint intake."
    };
  }

  if (subscription.status === "cancelled") {
    if (!periodEnd || periodEnd.getTime() <= now.getTime()) {
      return {
        allowed: false,
        code: "SUBSCRIPTION_EXPIRED",
        error: "Your cancelled subscription period has ended. Subscribe to a plan to continue."
      };
    }
    return { allowed: true };
  }

  if (subscription.status === "active") {
    if (periodEnd && periodEnd.getTime() <= now.getTime()) {
      return {
        allowed: false,
        code: "SUBSCRIPTION_EXPIRED",
        error: "Your subscription billing period has ended. Renew your plan to continue."
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    code: "SUBSCRIPTION_INACTIVE",
    error: "Subscription is not active."
  };
}

export async function reserveComplaintUsage(
  client: pg.PoolClient,
  workspaceId: string,
  now = new Date()
): Promise<BillingAccessCheck> {
  const subResult = await client.query<{
    id: string;
    status: WorkspaceSubscriptionStatus;
    current_period_end: string | null;
    custom_complaint_limit: number | null;
    monthly_complaint_limit: number | null;
  }>(
    `SELECT ws.id, ws.status, ws.current_period_end, ws.custom_complaint_limit, sp.monthly_complaint_limit
     FROM workspace_subscriptions ws
     JOIN subscription_plans sp ON sp.id = ws.plan_id
     WHERE ws.workspace_id = $1
     FOR UPDATE OF ws`,
    [workspaceId]
  );

  const sub = subResult.rows[0] ?? null;
  const access = evaluateSubscriptionAccess(sub, now);
  if (!access.allowed) {
    return {
      allowed: false,
      statusCode: 402,
      code: access.code,
      error: access.error,
      upgradeUrl: "/pricing"
    };
  }

  const period = getCurrentBillingPeriod(now);
  await client.query(
    `INSERT INTO monthly_usage_records (workspace_id, period_key, period_start, period_end, complaints_created)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (workspace_id, period_key) DO NOTHING`,
    [workspaceId, period.periodKey, period.periodStart.toISOString(), period.periodEnd.toISOString()]
  );

  const usageRow = await client.query<{ complaints_created: number }>(
    `SELECT complaints_created
     FROM monthly_usage_records
     WHERE workspace_id = $1 AND period_key = $2
     FOR UPDATE`,
    [workspaceId, period.periodKey]
  );

  const used = usageRow.rows[0]?.complaints_created ?? 0;
  const effectiveLimit = sub!.custom_complaint_limit ?? sub!.monthly_complaint_limit;

  if (effectiveLimit !== null && used >= effectiveLimit) {
    return {
      allowed: false,
      statusCode: 429,
      code: "USAGE_LIMIT_REACHED",
      error: `Monthly complaint limit (${effectiveLimit.toLocaleString("en-IN")}) reached for your current plan. Upgrade your plan to continue.`,
      upgradeUrl: "/pricing",
      usage: buildUsageSummary(used, effectiveLimit, period)
    };
  }

  const updated = await client.query<{ complaints_created: number }>(
    `UPDATE monthly_usage_records
     SET complaints_created = complaints_created + 1,
         last_complaint_at = $3,
         updated_at = now()
     WHERE workspace_id = $1 AND period_key = $2
     RETURNING complaints_created`,
    [workspaceId, period.periodKey, now.toISOString()]
  );

  return {
    allowed: true,
    usage: buildUsageSummary(updated.rows[0].complaints_created, effectiveLimit, period)
  };
}

export async function listSubscriptionPlans(pool: pg.Pool): Promise<SubscriptionPlanRow[]> {
  const result = await pool.query<SubscriptionPlanRow>(
    `SELECT id, code, name, tagline, target_audience, monthly_price_paise, currency,
            billing_interval, monthly_complaint_limit, max_workspaces, is_popular,
            is_custom, is_active, display_order, features, gateway_plan_id
     FROM subscription_plans
     WHERE is_active = true
     ORDER BY display_order ASC`
  );
  return result.rows;
}

export async function getWorkspaceBillingOverview(
  pool: pg.Pool,
  workspaceId: string,
  userRole: "owner" | "admin" | "member"
) {
  const subResult = await pool.query<
    WorkspaceSubscriptionRow & {
      plan_code: SubscriptionPlanRow["code"];
      plan_name: string;
      plan_tagline: string;
      monthly_price_paise: number | null;
      currency: string;
      monthly_complaint_limit: number | null;
      max_workspaces: number | null;
      plan_features: string[];
      pending_plan_code: string | null;
      pending_plan_name: string | null;
    }
  >(
    `SELECT ws.*,
            sp.code AS plan_code,
            sp.name AS plan_name,
            sp.tagline AS plan_tagline,
            sp.monthly_price_paise,
            sp.currency,
            sp.monthly_complaint_limit,
            sp.max_workspaces,
            sp.features AS plan_features,
            psp.code AS pending_plan_code,
            psp.name AS pending_plan_name
     FROM workspace_subscriptions ws
     JOIN subscription_plans sp ON sp.id = ws.plan_id
     LEFT JOIN subscription_plans psp ON psp.id = ws.pending_plan_id
     WHERE ws.workspace_id = $1`,
    [workspaceId]
  );

  const sub = subResult.rows[0] ?? null;
  const period = getCurrentBillingPeriod();
  const usageResult = await pool.query<{ complaints_created: number; last_complaint_at: string | null }>(
    `SELECT complaints_created, last_complaint_at
     FROM monthly_usage_records
     WHERE workspace_id = $1 AND period_key = $2`,
    [workspaceId, period.periodKey]
  );

  const used = usageResult.rows[0]?.complaints_created ?? 0;
  const effectiveLimit = sub ? sub.custom_complaint_limit ?? sub.monthly_complaint_limit : null;
  const usage = buildUsageSummary(used, effectiveLimit, period);
  const access = evaluateSubscriptionAccess(sub);

  const transactions = await pool.query<{
    id: string;
    provider_payment_id: string | null;
    provider_invoice_id: string | null;
    amount_paise: number;
    currency: string;
    status: string;
    payment_method: string | null;
    invoice_url: string | null;
    failure_reason: string | null;
    paid_at: string | null;
    created_at: string;
    plan_name: string | null;
  }>(
    `SELECT pt.id, pt.provider_payment_id, pt.provider_invoice_id, pt.amount_paise, pt.currency,
            pt.status, pt.payment_method, pt.invoice_url, pt.failure_reason, pt.paid_at, pt.created_at,
            sp.name AS plan_name
     FROM payment_transactions pt
     LEFT JOIN subscription_plans sp ON sp.id = pt.plan_id
     WHERE pt.workspace_id = $1
     ORDER BY pt.created_at DESC
     LIMIT 25`,
    [workspaceId]
  );

  const events = await pool.query<{
    id: string;
    event_type: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, event_type, metadata, created_at
     FROM subscription_events
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [workspaceId]
  );

  return {
    subscription: sub
      ? {
          id: sub.id,
          workspaceId: sub.workspace_id,
          status: sub.status,
          paymentProvider: sub.payment_provider,
          providerSubscriptionId: sub.provider_subscription_id,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd: sub.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          cancelledAt: sub.cancelled_at,
          lastPaymentAt: sub.last_payment_at,
          lastPaymentError: sub.last_payment_error,
          plan: {
            id: sub.plan_id,
            code: sub.plan_code,
            name: sub.plan_name,
            tagline: sub.plan_tagline,
            monthlyPricePaise: sub.monthly_price_paise,
            currency: sub.currency,
            monthlyComplaintLimit: effectiveLimit,
            maxWorkspaces: sub.max_workspaces,
            features: sub.plan_features
          },
          pendingPlan: sub.pending_plan_code
            ? { code: sub.pending_plan_code, name: sub.pending_plan_name }
            : null
        }
      : null,
    usage,
    accessAllowed: access.allowed,
    accessReason: access.allowed ? null : access.error,
    accessCode: access.allowed ? null : access.code,
    canManageBilling: userRole === "owner" || userRole === "admin",
    transactions: transactions.rows,
    events: events.rows
  };
}

async function resolveGatewayPlanId(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  plan: SubscriptionPlanRow
): Promise<string> {
  const envPlanId = envPlanIdForCode(plan.code);
  if (envPlanId) return envPlanId;
  if (plan.gateway_plan_id) return plan.gateway_plan_id;
  if (!plan.monthly_price_paise || plan.is_custom) {
    throw new BillingError("Enterprise plans require custom sales onboarding.", 400, "CUSTOM_PLAN");
  }
  const created = await gateway.createPlan({
    name: `NomaanOS ${plan.name} (Monthly)`,
    description: plan.tagline,
    amountPaise: plan.monthly_price_paise,
    currency: plan.currency
  });
  await pool.query(
    "UPDATE subscription_plans SET gateway_plan_id = $1, updated_at = now() WHERE id = $2",
    [created.id, plan.id]
  );
  return created.id;
}

export async function createWorkspaceSubscriptionCheckout(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  input: {
    workspaceId: string;
    workspaceName: string;
    userId: string;
    userEmail: string;
    userName: string;
    planCode: string;
  }
) {
  if (!gateway.isConfigured() || !gateway.getKeyId()) {
    throw new BillingError(
      "Razorpay payment gateway is not configured on this server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
      503,
      "GATEWAY_NOT_CONFIGURED"
    );
  }

  const planResult = await pool.query<SubscriptionPlanRow>(
    `SELECT * FROM subscription_plans WHERE code = $1 AND is_active = true`,
    [input.planCode]
  );
  const plan = planResult.rows[0];
  if (!plan) {
    throw new BillingError("Selected subscription plan was not found.", 404, "PLAN_NOT_FOUND");
  }
  if (plan.is_custom || plan.monthly_price_paise === null) {
    throw new BillingError("Enterprise plans require contacting sales.", 400, "ENTERPRISE_CONTACT_SALES");
  }

  const existingResult = await pool.query<WorkspaceSubscriptionRow & { plan_code: string }>(
    `SELECT ws.*, sp.code AS plan_code
     FROM workspace_subscriptions ws
     JOIN subscription_plans sp ON sp.id = ws.plan_id
     WHERE ws.workspace_id = $1`,
    [input.workspaceId]
  );
  const existing = existingResult.rows[0];
  if (existing && existing.status === "active") {
    if (existing.plan_code === plan.code) {
      throw new BillingError("This workspace already has an active subscription on this plan.", 409, "ALREADY_SUBSCRIBED");
    }
    throw new BillingError(
      "This workspace already has an active subscription. Use plan change to upgrade or downgrade.",
      409,
      "USE_PLAN_CHANGE"
    );
  }

  const gatewayPlanId = await resolveGatewayPlanId(pool, gateway, plan);

  let customerId = existing?.provider_customer_id ?? null;
  if (!customerId) {
    const customer = await gateway.createCustomer({
      name: input.userName || input.workspaceName,
      email: input.userEmail,
      notes: { workspace_id: input.workspaceId, workspace_name: input.workspaceName }
    });
    customerId = customer.id;
  }

  const rzSub = await gateway.createSubscription({
    planId: gatewayPlanId,
    customerId,
    totalCount: 120,
    notes: {
      workspace_id: input.workspaceId,
      plan_code: plan.code,
      initiated_by: input.userId
    }
  });

  const saved = await pool.query<WorkspaceSubscriptionRow>(
    `INSERT INTO workspace_subscriptions (
       workspace_id, plan_id, pending_plan_id, status, payment_provider,
       provider_customer_id, provider_subscription_id, provider_plan_id,
       cancel_at_period_end, last_payment_error, created_by
     )
     VALUES ($1, $2, NULL, 'payment_pending', 'razorpay', $3, $4, $5, false, NULL, $6)
     ON CONFLICT (workspace_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       pending_plan_id = NULL,
       status = 'payment_pending',
       provider_customer_id = EXCLUDED.provider_customer_id,
       provider_subscription_id = EXCLUDED.provider_subscription_id,
       provider_plan_id = EXCLUDED.provider_plan_id,
       cancel_at_period_end = false,
       cancelled_at = NULL,
       last_payment_error = NULL,
       updated_at = now()
     RETURNING *`,
    [input.workspaceId, plan.id, customerId, rzSub.id, gatewayPlanId, input.userId]
  );

  await pool.query(
    `INSERT INTO subscription_events (workspace_id, subscription_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, 'subscription.checkout_created', $3, $4::jsonb)`,
    [
      input.workspaceId,
      saved.rows[0].id,
      input.userId,
      JSON.stringify({ planCode: plan.code, providerSubscriptionId: rzSub.id })
    ]
  );

  return {
    subscription: saved.rows[0],
    checkout: {
      keyId: gateway.getKeyId()!,
      subscriptionId: rzSub.id,
      name: "NomaanOS",
      description: `${plan.name} Plan — Monthly Subscription`,
      amountPaise: plan.monthly_price_paise,
      currency: plan.currency,
      shortUrl: rzSub.short_url ?? null,
      prefill: {
        name: input.userName,
        email: input.userEmail
      }
    }
  };
}

function mapRazorpayStatus(rzStatus: string, fallback: WorkspaceSubscriptionStatus): WorkspaceSubscriptionStatus {
  switch (rzStatus) {
    case "active":
    case "authenticated":
      return "active";
    case "pending":
    case "halted":
      return "past_due";
    case "cancelled":
      return "cancelled";
    case "completed":
    case "expired":
      return "expired";
    case "created":
      return "payment_pending";
    default:
      return fallback;
  }
}

export async function verifyRazorpayCheckoutAndActivate(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  input: {
    workspaceId: string;
    userId: string;
    paymentId: string;
    subscriptionId: string;
    signature: string;
  }
) {
  const validSig = gateway.verifyCheckoutSignature({
    paymentId: input.paymentId,
    subscriptionId: input.subscriptionId,
    signature: input.signature
  });
  if (!validSig) {
    throw new BillingError("Invalid Razorpay payment signature. Payment was not verified.", 400, "INVALID_SIGNATURE");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const subResult = await client.query<
      WorkspaceSubscriptionRow & { monthly_price_paise: number | null; currency: string; plan_code: string }
    >(
      `SELECT ws.*, sp.monthly_price_paise, sp.currency, sp.code AS plan_code
       FROM workspace_subscriptions ws
       JOIN subscription_plans sp ON sp.id = ws.plan_id
       WHERE ws.workspace_id = $1 AND ws.provider_subscription_id = $2
       FOR UPDATE OF ws`,
      [input.workspaceId, input.subscriptionId]
    );
    const sub = subResult.rows[0];
    if (!sub) {
      throw new BillingError("Subscription not found for this workspace.", 404, "SUBSCRIPTION_NOT_FOUND");
    }

    let rzSub: RazorpaySubscription | null = null;
    try {
      rzSub = await gateway.fetchSubscription(input.subscriptionId);
    } catch {
      rzSub = null;
    }

    const now = new Date();
    const periodStart = unixSecondsToDate(rzSub?.current_start) ?? now;
    const periodEnd = unixSecondsToDate(rzSub?.current_end) ?? addOneMonth(periodStart);
    const nextStatus = rzSub ? mapRazorpayStatus(rzSub.status, "active") : "active";
    const resolvedStatus: WorkspaceSubscriptionStatus =
      nextStatus === "payment_pending" ? "active" : nextStatus;

    const updated = await client.query<WorkspaceSubscriptionRow>(
      `UPDATE workspace_subscriptions
       SET status = $2,
           current_period_start = COALESCE($3, current_period_start),
           current_period_end = COALESCE($4, current_period_end),
           last_payment_at = $5,
           last_payment_error = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sub.id, resolvedStatus, periodStart.toISOString(), periodEnd.toISOString(), now.toISOString()]
    );

    await client.query(
      `INSERT INTO payment_transactions (
         workspace_id, subscription_id, plan_id, provider, provider_payment_id,
         provider_subscription_id, amount_paise, currency, status, paid_at, metadata
       )
       VALUES ($1, $2, $3, 'razorpay', $4, $5, $6, $7, 'captured', $8, $9::jsonb)
       ON CONFLICT (provider_payment_id) DO UPDATE SET
         status = 'captured',
         paid_at = COALESCE(payment_transactions.paid_at, EXCLUDED.paid_at)`,
      [
        input.workspaceId,
        sub.id,
        sub.plan_id,
        input.paymentId,
        input.subscriptionId,
        sub.monthly_price_paise ?? 0,
        sub.currency,
        now.toISOString(),
        JSON.stringify({ source: "checkout_verification", planCode: sub.plan_code })
      ]
    );

    await client.query(
      `INSERT INTO subscription_events (workspace_id, subscription_id, event_type, actor_user_id, metadata)
       VALUES ($1, $2, 'subscription.activated', $3, $4::jsonb)`,
      [
        input.workspaceId,
        sub.id,
        input.userId,
        JSON.stringify({ paymentId: input.paymentId, subscriptionId: input.subscriptionId, status: resolvedStatus })
      ]
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function changeWorkspaceSubscriptionPlan(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  input: {
    workspaceId: string;
    userId: string;
    targetPlanCode: string;
  }
) {
  const targetPlanResult = await pool.query<SubscriptionPlanRow>(
    `SELECT * FROM subscription_plans WHERE code = $1 AND is_active = true`,
    [input.targetPlanCode]
  );
  const targetPlan = targetPlanResult.rows[0];
  if (!targetPlan) {
    throw new BillingError("Target subscription plan not found.", 404, "PLAN_NOT_FOUND");
  }
  if (targetPlan.is_custom || targetPlan.monthly_price_paise === null) {
    throw new BillingError("Enterprise plans require contacting sales.", 400, "ENTERPRISE_CONTACT_SALES");
  }

  const subResult = await pool.query<
    WorkspaceSubscriptionRow & { current_price_paise: number | null; current_plan_code: string }
  >(
    `SELECT ws.*, sp.monthly_price_paise AS current_price_paise, sp.code AS current_plan_code
     FROM workspace_subscriptions ws
     JOIN subscription_plans sp ON sp.id = ws.plan_id
     WHERE ws.workspace_id = $1`,
    [input.workspaceId]
  );
  const sub = subResult.rows[0];
  if (!sub || sub.status !== "active" || !sub.provider_subscription_id) {
    throw new BillingError("An active subscription is required to change plans.", 400, "NO_ACTIVE_SUBSCRIPTION");
  }
  if (sub.current_plan_code === targetPlan.code) {
    throw new BillingError("Workspace is already on this plan.", 409, "SAME_PLAN");
  }

  const isUpgrade = (targetPlan.monthly_price_paise ?? 0) > (sub.current_price_paise ?? 0);
  const gatewayPlanId = await resolveGatewayPlanId(pool, gateway, targetPlan);

  await gateway.updateSubscription(sub.provider_subscription_id, {
    planId: gatewayPlanId,
    scheduleChangeAt: isUpgrade ? "now" : "cycle_end"
  });

  const updated = isUpgrade
    ? await pool.query<WorkspaceSubscriptionRow>(
        `UPDATE workspace_subscriptions
         SET plan_id = $2,
             pending_plan_id = NULL,
             provider_plan_id = $3,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [sub.id, targetPlan.id, gatewayPlanId]
      )
    : await pool.query<WorkspaceSubscriptionRow>(
        `UPDATE workspace_subscriptions
         SET pending_plan_id = $2,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [sub.id, targetPlan.id]
      );

  await pool.query(
    `INSERT INTO subscription_events (workspace_id, subscription_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.workspaceId,
      sub.id,
      isUpgrade ? "subscription.upgraded" : "subscription.downgrade_scheduled",
      input.userId,
      JSON.stringify({ fromPlan: sub.current_plan_code, toPlan: targetPlan.code, immediate: isUpgrade })
    ]
  );

  return {
    subscription: updated.rows[0],
    effectiveImmediately: isUpgrade,
    message: isUpgrade
      ? `Upgraded to ${targetPlan.name}. Your new monthly limit is active immediately.`
      : `Downgrade to ${targetPlan.name} scheduled for the end of your current billing period.`
  };
}

export async function cancelWorkspaceSubscription(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  input: {
    workspaceId: string;
    userId: string;
    cancelAtPeriodEnd?: boolean;
  }
) {
  const cancelAtPeriodEnd = input.cancelAtPeriodEnd ?? true;
  const subResult = await pool.query<WorkspaceSubscriptionRow>(
    `SELECT * FROM workspace_subscriptions WHERE workspace_id = $1`,
    [input.workspaceId]
  );
  const sub = subResult.rows[0];
  if (!sub || !sub.provider_subscription_id) {
    throw new BillingError("No subscription found for this workspace.", 404, "SUBSCRIPTION_NOT_FOUND");
  }
  if (sub.status === "cancelled" || sub.status === "expired") {
    throw new BillingError("This subscription is already cancelled or expired.", 409, "ALREADY_CANCELLED");
  }

  if (sub.status === "active" || sub.status === "past_due") {
    await gateway.cancelSubscription(sub.provider_subscription_id, cancelAtPeriodEnd);
  }

  const nextStatus: WorkspaceSubscriptionStatus = cancelAtPeriodEnd && sub.status === "active" ? "active" : "cancelled";
  const updated = await pool.query<WorkspaceSubscriptionRow>(
    `UPDATE workspace_subscriptions
     SET status = $2,
         cancel_at_period_end = $3,
         cancelled_at = COALESCE(cancelled_at, now()),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [sub.id, nextStatus, cancelAtPeriodEnd]
  );

  await pool.query(
    `INSERT INTO subscription_events (workspace_id, subscription_id, event_type, actor_user_id, metadata)
     VALUES ($1, $2, 'subscription.cancelled', $3, $4::jsonb)`,
    [input.workspaceId, sub.id, input.userId, JSON.stringify({ cancelAtPeriodEnd })]
  );

  return updated.rows[0];
}

export async function processRazorpayWebhook(
  pool: pg.Pool,
  gateway: RazorpayGateway,
  input: {
    rawBody: Buffer;
    signature: string | undefined;
    eventIdHeader: string | undefined;
  }
): Promise<{ status: "processed" | "duplicate_ignored"; eventType: string }> {
  if (!gateway.verifyWebhookSignature(input.rawBody, input.signature)) {
    throw new BillingError("Invalid Razorpay webhook signature.", 401, "INVALID_WEBHOOK_SIGNATURE");
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8")) as Record<string, any>;
  } catch {
    throw new BillingError("Invalid JSON webhook payload.", 400, "INVALID_PAYLOAD");
  }

  const eventType = typeof payload.event === "string" ? payload.event : "unknown";
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const providerEventId =
    input.eventIdHeader && input.eventIdHeader.trim().length > 0
      ? input.eventIdHeader.trim()
      : `${eventType}:${payloadHash}`;

  const subEntity = payload?.payload?.subscription?.entity as Record<string, any> | undefined;
  const paymentEntity = payload?.payload?.payment?.entity as Record<string, any> | undefined;
  const providerSubscriptionId =
    (typeof subEntity?.id === "string" ? subEntity.id : null) ??
    (typeof paymentEntity?.subscription_id === "string" ? paymentEntity.subscription_id : null);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dedup = await client.query<{ id: string }>(
      `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, payload_hash)
       VALUES ('razorpay', $1, $2, $3)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [providerEventId, eventType, payloadHash]
    );
    if (!dedup.rows[0]) {
      await client.query("COMMIT");
      return { status: "duplicate_ignored", eventType };
    }

    if (providerSubscriptionId) {
      const subResult = await client.query<WorkspaceSubscriptionRow>(
        `SELECT * FROM workspace_subscriptions WHERE provider_subscription_id = $1 FOR UPDATE`,
        [providerSubscriptionId]
      );
      const sub = subResult.rows[0];
      if (sub) {
        await client.query(
          `UPDATE billing_webhook_events SET workspace_id = $2 WHERE id = $1`,
          [dedup.rows[0].id, sub.workspace_id]
        );

        const periodStart = unixSecondsToDate(subEntity?.current_start);
        const periodEnd = unixSecondsToDate(subEntity?.current_end);

        if (
          eventType === "subscription.authenticated" ||
          eventType === "subscription.activated" ||
          eventType === "subscription.charged"
        ) {
          const nextPlanId = sub.pending_plan_id ?? sub.plan_id;
          await client.query(
            `UPDATE workspace_subscriptions
             SET status = 'active',
                 plan_id = $2,
                 pending_plan_id = NULL,
                 current_period_start = COALESCE($3, current_period_start, now()),
                 current_period_end = COALESCE($4, current_period_end, now() + interval '1 month'),
                 last_payment_at = CASE WHEN $5 = 'subscription.charged' THEN now() ELSE last_payment_at END,
                 last_payment_error = NULL,
                 updated_at = now()
             WHERE id = $1`,
            [sub.id, nextPlanId, periodStart?.toISOString() ?? null, periodEnd?.toISOString() ?? null, eventType]
          );
        } else if (eventType === "subscription.pending" || eventType === "subscription.halted") {
          await client.query(
            `UPDATE workspace_subscriptions
             SET status = 'past_due',
                 last_payment_error = $2,
                 updated_at = now()
             WHERE id = $1`,
            [sub.id, eventType === "subscription.halted" ? "Subscription halted after repeated payment failures." : "Subscription payment pending."]
          );
        } else if (eventType === "subscription.cancelled") {
          await client.query(
            `UPDATE workspace_subscriptions
             SET status = 'cancelled',
                 cancelled_at = COALESCE(cancelled_at, now()),
                 updated_at = now()
             WHERE id = $1`,
            [sub.id]
          );
        } else if (eventType === "subscription.completed") {
          await client.query(
            `UPDATE workspace_subscriptions
             SET status = 'expired',
                 updated_at = now()
             WHERE id = $1`,
            [sub.id]
          );
        } else if (eventType === "payment.failed") {
          const errDesc =
            typeof paymentEntity?.error_description === "string"
              ? paymentEntity.error_description
              : "Payment failed.";
          await client.query(
            `UPDATE workspace_subscriptions
             SET status = CASE WHEN status = 'active' THEN 'past_due' ELSE 'payment_pending' END,
                 last_payment_error = $2,
                 updated_at = now()
             WHERE id = $1`,
            [sub.id, errDesc]
          );
        }

        if (paymentEntity && typeof paymentEntity.id === "string") {
          const payStatus =
            paymentEntity.status === "captured"
              ? "captured"
              : paymentEntity.status === "failed"
                ? "failed"
                : paymentEntity.status === "authorized"
                  ? "authorized"
                  : "created";
          await client.query(
            `INSERT INTO payment_transactions (
               workspace_id, subscription_id, plan_id, provider, provider_payment_id,
               provider_subscription_id, provider_invoice_id, amount_paise, currency,
               status, payment_method, failure_reason, paid_at, metadata
             )
             VALUES ($1, $2, $3, 'razorpay', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
             ON CONFLICT (provider_payment_id) DO UPDATE SET
               status = EXCLUDED.status,
               payment_method = COALESCE(EXCLUDED.payment_method, payment_transactions.payment_method),
               failure_reason = COALESCE(EXCLUDED.failure_reason, payment_transactions.failure_reason),
               paid_at = COALESCE(EXCLUDED.paid_at, payment_transactions.paid_at)`,
            [
              sub.workspace_id,
              sub.id,
              sub.plan_id,
              paymentEntity.id,
              providerSubscriptionId,
              typeof paymentEntity.invoice_id === "string" ? paymentEntity.invoice_id : null,
              typeof paymentEntity.amount === "number" ? paymentEntity.amount : 0,
              typeof paymentEntity.currency === "string" ? paymentEntity.currency : "INR",
              payStatus,
              typeof paymentEntity.method === "string" ? paymentEntity.method : null,
              typeof paymentEntity.error_description === "string" ? paymentEntity.error_description : null,
              payStatus === "captured" ? new Date().toISOString() : null,
              JSON.stringify({ webhookEvent: eventType })
            ]
          );
        }

        await client.query(
          `INSERT INTO subscription_events (workspace_id, subscription_id, event_type, metadata)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [sub.workspace_id, sub.id, `webhook.${eventType}`, JSON.stringify({ providerEventId })]
        );
      }
    }

    await client.query("COMMIT");
    return { status: "processed", eventType };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
