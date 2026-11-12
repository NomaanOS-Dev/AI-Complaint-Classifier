import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import type pg from "pg";
import {
  BillingError,
  cancelWorkspaceSubscription,
  changeWorkspaceSubscriptionPlan,
  createWorkspaceSubscriptionCheckout,
  getWorkspaceBillingOverview,
  listSubscriptionPlans,
  processRazorpayWebhook,
  verifyRazorpayCheckoutAndActivate
} from "./billing-service.js";
import { RazorpayApiError, type RazorpayGateway } from "./razorpay-client.js";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function handleBillingError(error: unknown, res: Response): boolean {
  if (error instanceof BillingError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof RazorpayApiError) {
    const status = error.statusCode >= 500 ? 502 : error.statusCode;
    res.status(status).json({ error: error.message, code: error.gatewayCode ?? "PAYMENT_GATEWAY_ERROR" });
    return true;
  }
  return false;
}

export function mountRazorpayWebhook(app: Express, pool: pg.Pool, gateway: RazorpayGateway): void {
  app.post(
    "/webhooks/razorpay",
    express.raw({ type: "application/json", limit: "256kb" }),
    asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Expected raw JSON webhook body." });
        return;
      }
      try {
        const result = await processRazorpayWebhook(pool, gateway, {
          rawBody: req.body,
          signature: req.get("x-razorpay-signature"),
          eventIdHeader: req.get("x-razorpay-event-id")
        });
        res.status(200).json(result);
      } catch (error) {
        if (handleBillingError(error, res)) return;
        throw error;
      }
    })
  );
}

export function mountBillingRoutes(
  app: Express,
  options: {
    pool: pg.Pool;
    gateway: RazorpayGateway;
    requireAuth: express.RequestHandler;
    csrfProtection: express.RequestHandler;
    requireWorkspaceRole: (roles: Array<"owner" | "admin" | "member">) => express.RequestHandler;
  }
): void {
  const { pool, gateway, requireAuth, csrfProtection, requireWorkspaceRole } = options;

  const inquiryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sales inquiries submitted. Please try again later." }
  });

  app.get(
    "/billing/plans",
    asyncRoute(async (_req, res) => {
      const plans = await listSubscriptionPlans(pool);
      res.json({
        plans: plans.map((plan) => ({
          id: plan.id,
          code: plan.code,
          name: plan.name,
          tagline: plan.tagline,
          targetAudience: plan.target_audience,
          monthlyPricePaise: plan.monthly_price_paise,
          currency: plan.currency,
          billingInterval: plan.billing_interval,
          monthlyComplaintLimit: plan.monthly_complaint_limit,
          maxWorkspaces: plan.max_workspaces,
          isPopular: plan.is_popular,
          isCustom: plan.is_custom,
          features: plan.features
        })),
        razorpayConfigured: gateway.isConfigured(),
        razorpayKeyId: gateway.getKeyId()
      });
    })
  );

  app.post(
    "/billing/enterprise-inquiry",
    inquiryLimiter,
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const company = typeof body.company === "string" ? body.company.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : null;
      const expectedVolume =
        typeof body.expectedMonthlyComplaints === "string" ? body.expectedMonthlyComplaints.trim() : null;
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const workspaceId = typeof body.workspaceId === "string" && /^[0-9a-f-]{36}$/i.test(body.workspaceId)
        ? body.workspaceId
        : null;

      if (
        name.length < 2 ||
        name.length > 120 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        company.length < 2 ||
        company.length > 160 ||
        message.length < 10 ||
        message.length > 3000
      ) {
        res.status(400).json({
          error: "Enter your name, a valid work email, company name, and details about your complaint volume (min 10 chars)."
        });
        return;
      }

      const sessionUserId = (req.session as { userId?: string } | undefined)?.userId ?? null;
      const result = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO enterprise_sales_inquiries (
           workspace_id, user_id, name, email, company, phone, expected_monthly_complaints, message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, created_at`,
        [workspaceId, sessionUserId, name, email, company, phone, expectedVolume, message]
      );

      res.status(201).json({
        inquiry: result.rows[0],
        message: "Thank you. Our enterprise team has received your inquiry and will contact you shortly."
      });
    })
  );

  app.get(
    "/workspaces/:workspaceId/billing",
    requireAuth,
    requireWorkspaceRole(["owner", "admin", "member"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const role = (res.locals.workspaceRole ?? "member") as "owner" | "admin" | "member";
      const overview = await getWorkspaceBillingOverview(pool, workspaceId, role);
      res.json({
        ...overview,
        razorpayConfigured: gateway.isConfigured(),
        razorpayKeyId: gateway.getKeyId()
      });
    })
  );

  app.post(
    "/workspaces/:workspaceId/billing/subscribe",
    requireAuth,
    csrfProtection,
    requireWorkspaceRole(["owner", "admin"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const planCode = typeof req.body?.planCode === "string" ? req.body.planCode.trim().toLowerCase() : "";
      if (!["starter", "growth", "business", "enterprise"].includes(planCode)) {
        res.status(400).json({ error: "Select a valid subscription plan." });
        return;
      }
      const user = res.locals.user as { id: string; email: string; name: string };
      const wsResult = await pool.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [workspaceId]);
      const workspaceName = wsResult.rows[0]?.name ?? "NomaanOS Workspace";

      try {
        const result = await createWorkspaceSubscriptionCheckout(pool, gateway, {
          workspaceId,
          workspaceName,
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
          planCode
        });
        res.status(201).json(result);
      } catch (error) {
        if (handleBillingError(error, res)) return;
        throw error;
      }
    })
  );

  app.post(
    "/workspaces/:workspaceId/billing/verify-payment",
    requireAuth,
    csrfProtection,
    requireWorkspaceRole(["owner", "admin"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const user = res.locals.user as { id: string };
      const paymentId = typeof req.body?.razorpay_payment_id === "string" ? req.body.razorpay_payment_id.trim() : "";
      const subscriptionId =
        typeof req.body?.razorpay_subscription_id === "string" ? req.body.razorpay_subscription_id.trim() : "";
      const signature = typeof req.body?.razorpay_signature === "string" ? req.body.razorpay_signature.trim() : "";

      if (!paymentId || !subscriptionId || !signature) {
        res.status(400).json({ error: "Missing Razorpay payment verification parameters." });
        return;
      }

      try {
        const subscription = await verifyRazorpayCheckoutAndActivate(pool, gateway, {
          workspaceId,
          userId: user.id,
          paymentId,
          subscriptionId,
          signature
        });
        res.json({ subscription, verified: true });
      } catch (error) {
        if (handleBillingError(error, res)) return;
        throw error;
      }
    })
  );

  app.post(
    "/workspaces/:workspaceId/billing/change-plan",
    requireAuth,
    csrfProtection,
    requireWorkspaceRole(["owner", "admin"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const user = res.locals.user as { id: string };
      const planCode = typeof req.body?.planCode === "string" ? req.body.planCode.trim().toLowerCase() : "";
      if (!["starter", "growth", "business", "enterprise"].includes(planCode)) {
        res.status(400).json({ error: "Select a valid target plan." });
        return;
      }

      try {
        const result = await changeWorkspaceSubscriptionPlan(pool, gateway, {
          workspaceId,
          userId: user.id,
          targetPlanCode: planCode
        });
        res.json(result);
      } catch (error) {
        if (handleBillingError(error, res)) return;
        throw error;
      }
    })
  );

  app.post(
    "/workspaces/:workspaceId/billing/cancel",
    requireAuth,
    csrfProtection,
    requireWorkspaceRole(["owner", "admin"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const user = res.locals.user as { id: string };
      const cancelAtPeriodEnd = req.body?.cancelAtPeriodEnd !== false;

      try {
        const subscription = await cancelWorkspaceSubscription(pool, gateway, {
          workspaceId,
          userId: user.id,
          cancelAtPeriodEnd
        });
        res.json({
          subscription,
          message: cancelAtPeriodEnd
            ? "Subscription cancellation scheduled. Your workspace will retain access until the end of the current billing period."
            : "Subscription cancelled immediately."
        });
      } catch (error) {
        if (handleBillingError(error, res)) return;
        throw error;
      }
    })
  );

  app.get(
    "/workspaces/:workspaceId/billing/invoices",
    requireAuth,
    requireWorkspaceRole(["owner", "admin", "member"]),
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const subResult = await pool.query<{ provider_subscription_id: string | null }>(
        "SELECT provider_subscription_id FROM workspace_subscriptions WHERE workspace_id = $1",
        [workspaceId]
      );
      const providerSubscriptionId = subResult.rows[0]?.provider_subscription_id ?? null;

      if (providerSubscriptionId && gateway.isConfigured()) {
        try {
          const rzInvoices = await gateway.fetchSubscriptionInvoices(providerSubscriptionId);
          for (const inv of rzInvoices) {
            if (inv.payment_id && inv.short_url) {
              await pool.query(
                `UPDATE payment_transactions
                 SET provider_invoice_id = COALESCE(provider_invoice_id, $1),
                     invoice_url = COALESCE(invoice_url, $2)
                 WHERE workspace_id = $3 AND provider_payment_id = $4`,
                [inv.id, inv.short_url, workspaceId, inv.payment_id]
              );
            }
          }
        } catch {
          // Non-fatal: still return persisted transaction records.
        }
      }

      const rows = await pool.query(
        `SELECT pt.id, pt.provider_payment_id, pt.provider_invoice_id, pt.amount_paise, pt.currency,
                pt.status, pt.payment_method, pt.invoice_url, pt.failure_reason, pt.paid_at, pt.created_at,
                sp.name AS plan_name
         FROM payment_transactions pt
         LEFT JOIN subscription_plans sp ON sp.id = pt.plan_id
         WHERE pt.workspace_id = $1
         ORDER BY pt.created_at DESC
         LIMIT 50`,
        [workspaceId]
      );
      res.json({ invoices: rows.rows });
    })
  );
}
