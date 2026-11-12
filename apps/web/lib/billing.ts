export type PlanCode = "starter" | "growth" | "business" | "enterprise";

export type SubscriptionPlan = {
  id: string;
  code: PlanCode;
  name: string;
  tagline: string;
  targetAudience: string;
  monthlyPricePaise: number | null;
  currency: string;
  billingInterval: "monthly" | "custom";
  monthlyComplaintLimit: number | null;
  maxWorkspaces: number | null;
  isPopular: boolean;
  isCustom: boolean;
  features: string[];
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

export type PaymentTransaction = {
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
};

export type BillingOverview = {
  subscription: {
    id: string;
    workspaceId: string;
    status: "created" | "payment_pending" | "active" | "past_due" | "cancelled" | "expired";
    paymentProvider: string;
    providerSubscriptionId: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelledAt: string | null;
    lastPaymentAt: string | null;
    lastPaymentError: string | null;
    plan: {
      id: string;
      code: PlanCode;
      name: string;
      tagline: string;
      monthlyPricePaise: number | null;
      currency: string;
      monthlyComplaintLimit: number | null;
      maxWorkspaces: number | null;
      features: string[];
    };
    pendingPlan: { code: string; name: string | null } | null;
  } | null;
  usage: UsageSummary;
  accessAllowed: boolean;
  accessReason: string | null;
  accessCode: string | null;
  canManageBilling: boolean;
  transactions: PaymentTransaction[];
  events: Array<{
    id: string;
    event_type: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>;
  razorpayConfigured: boolean;
  razorpayKeyId: string | null;
};

export function formatInrFromPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "Custom";
  const rupees = Math.round(paise / 100);
  return `₹${rupees.toLocaleString("en-IN")}`;
}

export function formatSubscriptionStatus(
  status: string | null | undefined,
  cancelAtPeriodEnd = false
): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (!status) return { label: "No Plan", tone: "neutral" };
  if (status === "active" && cancelAtPeriodEnd) {
    return { label: "Cancels at Period End", tone: "warning" };
  }
  switch (status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "created":
    case "payment_pending":
      return { label: "Payment Pending", tone: "warning" };
    case "past_due":
      return { label: "Past Due", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "warning" };
    case "expired":
      return { label: "Expired", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export function isUpgradeTransition(currentPricePaise: number | null, targetPricePaise: number | null): boolean {
  if (currentPricePaise === null || targetPricePaise === null) return false;
  return targetPricePaise > currentPricePaise;
}
