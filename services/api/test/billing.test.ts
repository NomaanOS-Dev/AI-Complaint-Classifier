import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import dotenv from "dotenv";
import pg from "pg";
import {
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type RazorpayGateway
} from "../src/razorpay-client.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });
process.env.SESSION_SECRET ??= randomBytes(48).toString("base64");
process.env.RESEND_API_KEY = "";
process.env.NODE_ENV = "test";

if (!existsSync("/.dockerenv") && process.env.DATABASE_URL) {
  const localTestUrl = new URL(process.env.DATABASE_URL);
  if (localTestUrl.hostname === "db") {
    localTestUrl.hostname = "127.0.0.1";
    localTestUrl.port = process.env.POSTGRES_PORT ?? "5435";
    process.env.DATABASE_URL = localTestUrl.toString();
  }
}

const { Pool } = pg;
const schema = `nomaanos_billing_test_${process.pid}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
let testPool: InstanceType<typeof Pool>;
let server: Server;
let baseUrl: string;
let createdSchema = false;

const TEST_KEY_ID = "rzp_test_nomaanos123";
const TEST_KEY_SECRET = "rzp_test_secret_nomaanos_987654321";
const TEST_WEBHOOK_SECRET = "rzp_whsec_nomaanos_123456789";

function createMockGateway(): RazorpayGateway {
  let seq = 1;
  return {
    isConfigured: () => true,
    getKeyId: () => TEST_KEY_ID,
    async createCustomer({ name, email }) {
      return { id: `cust_test_${seq++}`, name, email };
    },
    async createPlan({ name, amountPaise, currency = "INR", description }) {
      return {
        id: `plan_test_${seq++}`,
        period: "monthly",
        interval: 1,
        item: { name, amount: amountPaise, currency, description }
      };
    },
    async createSubscription({ planId, customerId }) {
      const id = `sub_test_${seq++}`;
      return {
        id,
        plan_id: planId,
        customer_id: customerId ?? null,
        status: "created",
        short_url: `https://rzp.io/i/${id}`
      };
    },
    async fetchSubscription(subscriptionId) {
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        id: subscriptionId,
        plan_id: "plan_test_1",
        status: "active",
        current_start: nowSec,
        current_end: nowSec + 30 * 24 * 3600
      };
    },
    async updateSubscription(subscriptionId, { planId }) {
      return {
        id: subscriptionId,
        plan_id: planId,
        status: "active"
      };
    },
    async cancelSubscription(subscriptionId) {
      return {
        id: subscriptionId,
        plan_id: "plan_test_1",
        status: "cancelled"
      };
    },
    async fetchSubscriptionInvoices() {
      return [];
    },
    verifyCheckoutSignature({ paymentId, subscriptionId, signature }) {
      return verifyRazorpayCheckoutSignature(paymentId, subscriptionId, signature, TEST_KEY_SECRET);
    },
    verifyWebhookSignature(rawBody, signature) {
      return verifyRazorpayWebhookSignature(rawBody, signature, TEST_WEBHOOK_SECRET);
    }
  };
}

class ApiClient {
  cookie = "";
  csrfToken = "";

  async request(pathname: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && !headers.has("x-csrf-token")) {
      if (!this.csrfToken) {
        const csrfRes = await fetch(`${baseUrl}/auth/csrf`, {
          headers: this.cookie ? { cookie: this.cookie } : undefined
        });
        const setCookie = csrfRes.headers.getSetCookie?.() ?? [];
        if (setCookie[0]) this.cookie = setCookie[0].split(";")[0];
        const csrfData = (await csrfRes.json()) as { csrfToken?: string };
        if (csrfData.csrfToken) this.csrfToken = csrfData.csrfToken;
      }
      headers.set("x-csrf-token", this.csrfToken);
      if (this.cookie) headers.set("cookie", this.cookie);
    }
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, method, headers });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies[0]) this.cookie = setCookies[0].split(";")[0];
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (typeof body.csrfToken === "string") this.csrfToken = body.csrfToken;
    return { status: res.status, body, headers: res.headers };
  }
}

async function registerAndVerifyUser(email: string, name: string, workspaceName: string) {
  const client = new ApiClient();
  const reg = await client.request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: "StrongPassword!123", workspaceName })
  });
  assert.equal(reg.status, 201);
  await testPool.query("UPDATE users SET email_verified = true WHERE lower(email) = lower($1)", [email]);
  return { client, workspaceId: reg.body.workspace.id as string, userId: reg.body.user.id as string };
}

describe("SaaS pricing, Razorpay subscriptions, webhooks, and usage enforcement", () => {
  before(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    const testDbUrl = new URL(process.env.DATABASE_URL!);
    testDbUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = testDbUrl.toString();
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");

    testPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const { migrate } = await import("../src/db.js");
    await migrate();
    const { createApp } = await import("../src/app.js");
    const app = createApp({ razorpayGateway: createMockGateway() });
    server = app.listen(0);
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Server address unavailable");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server?.close();
    await testPool?.end();
    if (createdSchema) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await adminPool.end();
  });

  test("lists all 4 configured SaaS plans in INR with Growth highlighted", async () => {
    const res = await fetch(`${baseUrl}/billing/plans`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { plans: Array<Record<string, any>>; razorpayConfigured: boolean };
    assert.equal(data.razorpayConfigured, true);
    assert.equal(data.plans.length, 4);
    assert.deepEqual(
      data.plans.map((p) => [p.code, p.monthlyPricePaise, p.monthlyComplaintLimit, p.isPopular]),
      [
        ["starter", 99900, 500, false],
        ["growth", 249900, 2500, true],
        ["business", 599900, 10000, false],
        ["enterprise", null, null, false]
      ]
    );
  });

  test("enforces unsubscribed workspace rejection, activates Starter via verified Razorpay checkout, and rejects tampered signatures", async () => {
    const { client, workspaceId } = await registerAndVerifyUser("owner1@billing.test", "Owner One", "Billing Co");

    // 1. Unsubscribed workspace cannot create complaints
    const blocked = await client.request(`/workspaces/${workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "No plan", description: "Should be rejected without subscription" })
    });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.code, "SUBSCRIPTION_REQUIRED");

    // 2. Create Razorpay subscription for Starter plan
    const subRes = await client.request(`/workspaces/${workspaceId}/billing/subscribe`, {
      method: "POST",
      body: JSON.stringify({ planCode: "starter" })
    });
    assert.equal(subRes.status, 201);
    const razorpaySubscriptionId = subRes.body.checkout.subscriptionId as string;
    assert.ok(razorpaySubscriptionId.startsWith("sub_test_"));

    // 3. Invalid checkout signature is rejected and does NOT activate
    const badVerify = await client.request(`/workspaces/${workspaceId}/billing/verify-payment`, {
      method: "POST",
      body: JSON.stringify({
        razorpay_payment_id: "pay_test_101",
        razorpay_subscription_id: razorpaySubscriptionId,
        razorpay_signature: "0".repeat(64)
      })
    });
    assert.equal(badVerify.status, 400);
    assert.equal(badVerify.body.code, "INVALID_SIGNATURE");

    // 4. Valid HMAC signature activates subscription and records payment transaction
    const paymentId = "pay_test_101";
    const validSignature = createHmac("sha256", TEST_KEY_SECRET)
      .update(`${paymentId}|${razorpaySubscriptionId}`)
      .digest("hex");

    const goodVerify = await client.request(`/workspaces/${workspaceId}/billing/verify-payment`, {
      method: "POST",
      body: JSON.stringify({
        razorpay_payment_id: paymentId,
        razorpay_subscription_id: razorpaySubscriptionId,
        razorpay_signature: validSignature
      })
    });
    assert.equal(goodVerify.status, 200);
    assert.equal(goodVerify.body.verified, true);
    assert.equal(goodVerify.body.subscription.status, "active");

    const overview = await client.request(`/workspaces/${workspaceId}/billing`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.subscription.plan.code, "starter");
    assert.equal(overview.body.transactions.length, 1);
    assert.equal(overview.body.transactions[0].status, "captured");
  });

  test("tracks usage accurately across manual, API, and public form; prevents double-counting on idempotent replays; enforces 100% limit & upgrades", async () => {
    const { client, workspaceId } = await registerAndVerifyUser("owner2@billing.test", "Owner Two", "Usage Co");

    // Subscribe & activate Starter
    const subRes = await client.request(`/workspaces/${workspaceId}/billing/subscribe`, {
      method: "POST",
      body: JSON.stringify({ planCode: "starter" })
    });
    const subId = subRes.body.checkout.subscriptionId as string;
    const payId = "pay_test_202";
    const sig = createHmac("sha256", TEST_KEY_SECRET).update(`${payId}|${subId}`).digest("hex");
    await client.request(`/workspaces/${workspaceId}/billing/verify-payment`, {
      method: "POST",
      body: JSON.stringify({
        razorpay_payment_id: payId,
        razorpay_subscription_id: subId,
        razorpay_signature: sig
      })
    });

    // Manual complaint #1
    const c1 = await client.request(`/workspaces/${workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "Manual issue", description: "Manual complaint body" })
    });
    assert.equal(c1.status, 201);

    // Invalid manual complaint should NOT increment usage
    const invalidComplaint = await client.request(`/workspaces/${workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "", description: "" })
    });
    assert.equal(invalidComplaint.status, 400);

    // Integration API complaint #2 + idempotent replay (should stay at 2!)
    const credRes = await client.request(`/workspaces/${workspaceId}/integrations/credentials`, {
      method: "POST",
      body: JSON.stringify({ name: "Usage Test Key" })
    });
    assert.equal(credRes.status, 201);
    const apiToken = credRes.body.secret as string;

    const apiCreate1 = await fetch(`${baseUrl}/api/v1/integrations/complaints`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-usage-1"
      },
      body: JSON.stringify({ title: "API issue", description: "From integration" })
    });
    assert.equal(apiCreate1.status, 201);

    const apiReplay = await fetch(`${baseUrl}/api/v1/integrations/complaints`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "idem-usage-1"
      },
      body: JSON.stringify({ title: "API issue", description: "From integration" })
    });
    assert.equal(apiReplay.status, 200);
    assert.equal(apiReplay.headers.get("idempotent-replayed"), "true");

    // Public contact form complaint #3 + idempotent replay
    const formRes = await client.request(`/workspaces/${workspaceId}/integrations/contact-form`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(formRes.status, 201);
    const formToken = formRes.body.token as string;

    const pubCreate = await fetch(`${baseUrl}/public/contact/${formToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "pub-usage-1" },
      body: JSON.stringify({
        name: "Customer",
        email: "cust@example.test",
        subject: "Public form issue",
        description: "Submitted via public contact form"
      })
    });
    assert.equal(pubCreate.status, 201);

    const pubReplay = await fetch(`${baseUrl}/public/contact/${formToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "pub-usage-1" },
      body: JSON.stringify({
        name: "Customer",
        email: "cust@example.test",
        subject: "Public form issue",
        description: "Submitted via public contact form"
      })
    });
    assert.equal(pubReplay.status, 200);

    let overview = await client.request(`/workspaces/${workspaceId}/billing`);
    assert.equal(overview.body.usage.complaintsUsed, 3);
    assert.equal(overview.body.usage.monthlyLimit, 500);

    // Simulate reaching 400 (80% nearLimit warning) then 500 (limitReached)
    await testPool.query(
      "UPDATE monthly_usage_records SET complaints_created = 400 WHERE workspace_id = $1",
      [workspaceId]
    );
    overview = await client.request(`/workspaces/${workspaceId}/billing`);
    assert.equal(overview.body.usage.percentUsed, 80);
    assert.equal(overview.body.usage.nearLimit, true);
    assert.equal(overview.body.usage.limitReached, false);

    await testPool.query(
      "UPDATE monthly_usage_records SET complaints_created = 500 WHERE workspace_id = $1",
      [workspaceId]
    );
    const limitBlocked = await client.request(`/workspaces/${workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "Over limit", description: "Should be blocked at 500" })
    });
    assert.equal(limitBlocked.status, 429);
    assert.equal(limitBlocked.body.code, "USAGE_LIMIT_REACHED");

    // Upgrade from Starter (500) -> Growth (2500) immediately unlocks complaint creation!
    const upgradeRes = await client.request(`/workspaces/${workspaceId}/billing/change-plan`, {
      method: "POST",
      body: JSON.stringify({ planCode: "growth" })
    });
    assert.equal(upgradeRes.status, 200);
    assert.equal(upgradeRes.body.effectiveImmediately, true);

    const afterUpgrade = await client.request(`/workspaces/${workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "Post upgrade", description: "Now allowed on Growth" })
    });
    assert.equal(afterUpgrade.status, 201);
  });

  test("handles Razorpay webhooks idempotently, payment failure past_due enforcement, cancellation period retention, and tenant isolation", async () => {
    const ownerA = await registerAndVerifyUser("ownerA@billing.test", "Owner A", "Workspace A");
    const ownerB = await registerAndVerifyUser("ownerB@billing.test", "Owner B", "Workspace B");

    const subRes = await ownerA.client.request(`/workspaces/${ownerA.workspaceId}/billing/subscribe`, {
      method: "POST",
      body: JSON.stringify({ planCode: "starter" })
    });
    const subId = subRes.body.checkout.subscriptionId as string;

    // Cross-workspace isolation: Owner B cannot view or modify Owner A's billing
    const crossRead = await ownerB.client.request(`/workspaces/${ownerA.workspaceId}/billing`);
    assert.equal(crossRead.status, 404);
    const crossVerify = await ownerB.client.request(`/workspaces/${ownerB.workspaceId}/billing/verify-payment`, {
      method: "POST",
      body: JSON.stringify({
        razorpay_payment_id: "pay_hijack",
        razorpay_subscription_id: subId,
        razorpay_signature: createHmac("sha256", TEST_KEY_SECRET).update(`pay_hijack|${subId}`).digest("hex")
      })
    });
    assert.equal(crossVerify.status, 404);

    // Send signed subscription.charged webhook
    const chargedPayload = JSON.stringify({
      event: "subscription.charged",
      payload: {
        subscription: {
          entity: {
            id: subId,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 86400 * 30
          }
        },
        payment: {
          entity: {
            id: "pay_wh_303",
            subscription_id: subId,
            amount: 99900,
            currency: "INR",
            status: "captured",
            method: "upi"
          }
        }
      }
    });
    const chargedSig = createHmac("sha256", TEST_WEBHOOK_SECRET).update(chargedPayload).digest("hex");

    const wh1 = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": chargedSig,
        "x-razorpay-event-id": "evt_charged_303"
      },
      body: chargedPayload
    });
    assert.equal(wh1.status, 200);
    assert.equal(((await wh1.json()) as { status: string }).status, "processed");

    // Duplicate webhook delivery must be ignored
    const whDup = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": chargedSig,
        "x-razorpay-event-id": "evt_charged_303"
      },
      body: chargedPayload
    });
    assert.equal(whDup.status, 200);
    assert.equal(((await whDup.json()) as { status: string }).status, "duplicate_ignored");

    // Payment failure webhook marks workspace past_due and blocks complaints
    const failPayload = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_wh_fail_304",
            subscription_id: subId,
            amount: 99900,
            currency: "INR",
            status: "failed",
            error_description: "Insufficient funds"
          }
        }
      }
    });
    const failSig = createHmac("sha256", TEST_WEBHOOK_SECRET).update(failPayload).digest("hex");
    const whFail = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": failSig,
        "x-razorpay-event-id": "evt_fail_304"
      },
      body: failPayload
    });
    assert.equal(whFail.status, 200);

    const pastDueBlocked = await ownerA.client.request(`/workspaces/${ownerA.workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "Past due check", description: "Should be blocked" })
    });
    assert.equal(pastDueBlocked.status, 402);
    assert.equal(pastDueBlocked.body.code, "SUBSCRIPTION_INACTIVE");

    // Restore active via webhook, then cancel at period end -> retains access until current_period_end
    await testPool.query(
      "UPDATE workspace_subscriptions SET status = 'active' WHERE workspace_id = $1",
      [ownerA.workspaceId]
    );
    const cancelRes = await ownerA.client.request(`/workspaces/${ownerA.workspaceId}/billing/cancel`, {
      method: "POST",
      body: JSON.stringify({ cancelAtPeriodEnd: true })
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.subscription.cancel_at_period_end, true);

    const stillAllowed = await ownerA.client.request(`/workspaces/${ownerA.workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "During grace period", description: "Allowed until period end" })
    });
    assert.equal(stillAllowed.status, 201);

    // Expire current_period_end -> now rejected
    await testPool.query(
      "UPDATE workspace_subscriptions SET status = 'cancelled', current_period_end = now() - interval '1 hour' WHERE workspace_id = $1",
      [ownerA.workspaceId]
    );
    const expiredBlocked = await ownerA.client.request(`/workspaces/${ownerA.workspaceId}/complaints`, {
      method: "POST",
      body: JSON.stringify({ title: "After expiry", description: "Should be rejected" })
    });
    assert.equal(expiredBlocked.status, 402);
    assert.equal(expiredBlocked.body.code, "SUBSCRIPTION_EXPIRED");
  });

  test("accepts Enterprise Contact Sales inquiry", async () => {
    const res = await fetch(`${baseUrl}/billing/enterprise-inquiry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Priya Nair",
        email: "priya@enterprise.example",
        company: "MegaCorp India",
        expectedMonthlyComplaints: "50,000+",
        message: "We need custom SLA, SSO, and multi-region complaint routing."
      })
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { inquiry?: { id: string } };
    assert.ok(data.inquiry?.id);
  });
});
