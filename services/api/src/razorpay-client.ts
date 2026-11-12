import { createHmac, timingSafeEqual } from "node:crypto";

export interface RazorpayCustomer {
  id: string;
  name?: string;
  email?: string;
}

export interface RazorpayPlan {
  id: string;
  period: string;
  interval: number;
  item: {
    id?: string;
    name: string;
    amount: number;
    currency: string;
    description?: string;
  };
}

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  customer_id?: string | null;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  charge_at?: number | null;
  ended_at?: number | null;
  short_url?: string | null;
  paid_count?: number;
  total_count?: number;
}

export interface RazorpayInvoice {
  id: string;
  subscription_id?: string | null;
  payment_id?: string | null;
  status: string;
  amount: number;
  currency: string;
  short_url?: string | null;
  issued_at?: number | null;
  paid_at?: number | null;
}

export interface RazorpayGateway {
  isConfigured(): boolean;
  getKeyId(): string | null;
  createCustomer(input: { name: string; email: string; notes?: Record<string, string> }): Promise<RazorpayCustomer>;
  createPlan(input: {
    name: string;
    description: string;
    amountPaise: number;
    currency?: string;
  }): Promise<RazorpayPlan>;
  createSubscription(input: {
    planId: string;
    customerId?: string;
    totalCount?: number;
    notes?: Record<string, string>;
  }): Promise<RazorpaySubscription>;
  fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription>;
  updateSubscription(
    subscriptionId: string,
    input: { planId: string; scheduleChangeAt: "now" | "cycle_end" }
  ): Promise<RazorpaySubscription>;
  cancelSubscription(subscriptionId: string, cancelAtCycleEnd: boolean): Promise<RazorpaySubscription>;
  fetchSubscriptionInvoices(subscriptionId: string): Promise<RazorpayInvoice[]>;
  verifyCheckoutSignature(input: {
    paymentId: string;
    subscriptionId: string;
    signature: string;
  }): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean;
}

const PLACEHOLDER_PREFIX = "replace-with-";
const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function isNonPlaceholder(value: string | undefined): value is string {
  return Boolean(value && value.trim().length > 0 && !value.trim().startsWith(PLACEHOLDER_PREFIX));
}

function safeHexCompare(expectedHex: string, suppliedHex: string): boolean {
  const cleanSupplied = suppliedHex.trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(cleanSupplied) || cleanSupplied.length !== expectedHex.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(cleanSupplied, "utf8"));
}

export function verifyRazorpayCheckoutSignature(
  paymentId: string,
  subscriptionId: string,
  signature: string,
  keySecret: string
): boolean {
  if (!paymentId || !subscriptionId || !signature || !keySecret) return false;
  const expected = createHmac("sha256", keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
  return safeHexCompare(expected, signature);
}

export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  webhookSecret: string
): boolean {
  if (!rawBody || rawBody.length === 0 || !signature || !webhookSecret) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return safeHexCompare(expected, signature);
}

export class RazorpayApiError extends Error {
  readonly statusCode: number;
  readonly gatewayCode?: string;

  constructor(message: string, statusCode: number, gatewayCode?: string) {
    super(message);
    this.name = "RazorpayApiError";
    this.statusCode = statusCode;
    this.gatewayCode = gatewayCode;
  }
}

export function createRazorpayGateway(options?: {
  keyId?: string;
  keySecret?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
}): RazorpayGateway {
  const getKeyIdValue = () => options?.keyId ?? process.env.RAZORPAY_KEY_ID;
  const getKeySecretValue = () => options?.keySecret ?? process.env.RAZORPAY_KEY_SECRET;
  const getWebhookSecretValue = () => options?.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET;
  const fetchFn = options?.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const keyId = getKeyIdValue();
    const keySecret = getKeySecretValue();
    if (!isNonPlaceholder(keyId) || !isNonPlaceholder(keySecret)) {
      throw new RazorpayApiError("Razorpay credentials are not configured on the server.", 503, "GATEWAY_NOT_CONFIGURED");
    }

    const auth = Buffer.from(`${keyId.trim()}:${keySecret.trim()}`).toString("base64");
    const response = await fetchFn(`${RAZORPAY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) {
      const gatewayMessage =
        typeof data?.error?.description === "string"
          ? data.error.description
          : typeof data?.error?.reason === "string"
            ? data.error.reason
            : `Razorpay API returned status ${response.status}`;
      const gatewayCode = typeof data?.error?.code === "string" ? data.error.code : undefined;
      throw new RazorpayApiError(gatewayMessage, response.status, gatewayCode);
    }

    return data as T;
  }

  return {
    isConfigured() {
      return isNonPlaceholder(getKeyIdValue()) && isNonPlaceholder(getKeySecretValue());
    },
    getKeyId() {
      const keyId = getKeyIdValue();
      return isNonPlaceholder(keyId) ? keyId.trim() : null;
    },
    createCustomer(input) {
      return request<RazorpayCustomer>("POST", "/customers", {
        name: input.name,
        email: input.email,
        fail_existing: 0,
        notes: input.notes ?? {}
      });
    },
    createPlan(input) {
      return request<RazorpayPlan>("POST", "/plans", {
        period: "monthly",
        interval: 1,
        item: {
          name: input.name,
          amount: input.amountPaise,
          currency: input.currency ?? "INR",
          description: input.description
        }
      });
    },
    createSubscription(input) {
      return request<RazorpaySubscription>("POST", "/subscriptions", {
        plan_id: input.planId,
        ...(input.customerId ? { customer_id: input.customerId } : {}),
        total_count: input.totalCount ?? 120,
        quantity: 1,
        customer_notify: 1,
        notes: input.notes ?? {}
      });
    },
    fetchSubscription(subscriptionId) {
      return request<RazorpaySubscription>("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
    updateSubscription(subscriptionId, input) {
      return request<RazorpaySubscription>("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        plan_id: input.planId,
        schedule_change_at: input.scheduleChangeAt
      });
    },
    cancelSubscription(subscriptionId, cancelAtCycleEnd) {
      return request<RazorpaySubscription>("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0
      });
    },
    async fetchSubscriptionInvoices(subscriptionId) {
      const res = await request<{ items?: RazorpayInvoice[] }>(
        "GET",
        `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`
      );
      return Array.isArray(res.items) ? res.items : [];
    },
    verifyCheckoutSignature({ paymentId, subscriptionId, signature }) {
      const secret = getKeySecretValue();
      if (!isNonPlaceholder(secret)) return false;
      return verifyRazorpayCheckoutSignature(paymentId, subscriptionId, signature, secret.trim());
    },
    verifyWebhookSignature(rawBody, signature) {
      const secret = getWebhookSecretValue();
      if (!isNonPlaceholder(secret)) return false;
      return verifyRazorpayWebhookSignature(rawBody, signature, secret.trim());
    }
  };
}
