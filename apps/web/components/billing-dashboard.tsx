"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiErrorMessage, apiRequest } from "../lib/api";
import {
  formatInrFromPaise,
  formatSubscriptionStatus,
  isUpgradeTransition,
  type BillingOverview,
  type PlanCode,
  type SubscriptionPlan
} from "../lib/billing";
import { loadRazorpayCheckoutScript } from "../lib/razorpay";
import { TwoLayerNavbar } from "./brand-logo";
import { AnimatedCounter, Reveal, SkeletonGrid } from "./motion-primitives";

type WorkspaceItem = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

export default function BillingDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialWorkspaceId = searchParams.get("workspaceId") ?? "";

  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(initialWorkspaceId);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const loadBilling = useCallback(async (workspaceId: string) => {
    if (!workspaceId) return;
    setError(null);
    const res = await apiRequest<BillingOverview>(`/workspaces/${workspaceId}/billing`);
    if (!res.response.ok) {
      setError(apiErrorMessage(res.data, "Could not load billing information."));
      return;
    }
    setOverview(res.data);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const meRes = await apiRequest<{ user?: { id: string } }>("/auth/me");
      if (!active) return;
      if (!meRes.response.ok || !meRes.data.user) {
        router.replace("/login?next=/billing");
        return;
      }

      const [wsRes, plansRes] = await Promise.all([
        apiRequest<{ workspaces?: WorkspaceItem[] }>("/workspaces"),
        apiRequest<{ plans?: SubscriptionPlan[] }>("/billing/plans")
      ]);
      if (!active) return;

      if (plansRes.response.ok && Array.isArray(plansRes.data.plans)) {
        setPlans(plansRes.data.plans);
      }

      const list = Array.isArray(wsRes.data.workspaces) ? wsRes.data.workspaces : [];
      setWorkspaces(list);
      const targetWs =
        list.find((w) => w.id === initialWorkspaceId)?.id ??
        list.find((w) => w.role === "owner" || w.role === "admin")?.id ??
        list[0]?.id ??
        "";
      setSelectedWorkspaceId(targetWs);

      if (targetWs) {
        await loadBilling(targetWs);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [initialWorkspaceId, loadBilling, router]);

  async function handleWorkspaceChange(nextId: string) {
    setSelectedWorkspaceId(nextId);
    setNotice(null);
    await loadBilling(nextId);
  }

  async function handleSubscribeOrSwitch(plan: SubscriptionPlan) {
    if (!selectedWorkspaceId) return;
    if (plan.isCustom || plan.code === "enterprise") {
      router.push("/pricing");
      return;
    }

    setError(null);
    setNotice(null);
    setActionBusy(true);

    try {
      const currentSub = overview?.subscription;
      if (currentSub && currentSub.status === "active") {
        const res = await apiRequest<{ message?: string }>(
          `/workspaces/${selectedWorkspaceId}/billing/change-plan`,
          {
            method: "POST",
            body: JSON.stringify({ planCode: plan.code })
          }
        );
        if (!res.response.ok) {
          setError(apiErrorMessage(res.data, "Could not update subscription plan."));
          return;
        }
        setNotice(res.data.message ?? `Plan updated to ${plan.name}.`);
        await loadBilling(selectedWorkspaceId);
        return;
      }

      const subRes = await apiRequest<{
        checkout?: {
          keyId: string;
          subscriptionId: string;
          name: string;
          description: string;
          prefill?: { name?: string; email?: string };
        };
      }>(`/workspaces/${selectedWorkspaceId}/billing/subscribe`, {
        method: "POST",
        body: JSON.stringify({ planCode: plan.code })
      });

      if (!subRes.response.ok || !subRes.data.checkout) {
        setError(apiErrorMessage(subRes.data, "Could not initiate Razorpay checkout."));
        return;
      }

      const loaded = await loadRazorpayCheckoutScript();
      if (!loaded || !window.Razorpay) {
        setError("Failed to load Razorpay Checkout.");
        return;
      }

      const checkout = subRes.data.checkout;
      const rz = new window.Razorpay({
        key: checkout.keyId,
        subscription_id: checkout.subscriptionId,
        name: checkout.name,
        description: checkout.description,
        prefill: checkout.prefill,
        theme: { color: "#6366f1" },
        handler: async (paymentResponse) => {
          const verifyRes = await apiRequest<{ verified?: boolean }>(
            `/workspaces/${selectedWorkspaceId}/billing/verify-payment`,
            {
              method: "POST",
              body: JSON.stringify(paymentResponse)
            }
          );
          if (verifyRes.response.ok && verifyRes.data.verified) {
            router.push(
              `/billing/success?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&plan=${encodeURIComponent(plan.name)}`
            );
          } else {
            router.push(
              `/billing/failure?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&reason=${encodeURIComponent(
                apiErrorMessage(verifyRes.data, "Payment verification failed.")
              )}`
            );
          }
        },
        modal: {
          ondismiss: () => {
            setActionBusy(false);
          }
        }
      });

      rz.on("payment.failed", (evt) => {
        const reason = evt?.error?.description || evt?.error?.reason || "Payment failed.";
        router.push(
          `/billing/failure?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&reason=${encodeURIComponent(reason)}`
        );
      });

      rz.open();
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancelSubscription() {
    if (!selectedWorkspaceId) return;
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ message?: string }>(
        `/workspaces/${selectedWorkspaceId}/billing/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ cancelAtPeriodEnd: true })
        }
      );
      if (!res.response.ok) {
        setError(apiErrorMessage(res.data, "Could not cancel subscription."));
        return;
      }
      setCancelConfirmOpen(false);
      setNotice(res.data.message ?? "Subscription cancellation scheduled.");
      await loadBilling(selectedWorkspaceId);
    } finally {
      setActionBusy(false);
    }
  }

  const sub = overview?.subscription ?? null;
  const statusInfo = formatSubscriptionStatus(sub?.status, sub?.cancelAtPeriodEnd);
  const usage = overview?.usage;
  const paidPlans = plans.filter((p) => !p.isCustom);

  return (
    <div className="dashboard-shell">
      <TwoLayerNavbar>
        <Link className="text-button" href="/dashboard">Dashboard</Link>
        <Link className="text-button" href={selectedWorkspaceId ? `/complaints?workspace=${selectedWorkspaceId}` : "/complaints"}>
          Complaints
        </Link>
        <Link className="text-button" href="/pricing">Pricing</Link>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            await apiRequest("/auth/logout", { method: "POST", body: "{}" });
            router.replace("/login");
          }}
        >
          Log out
        </button>
      </TwoLayerNavbar>

      <main className="billing-main">
        <header className="billing-header">
          <div>
            <p className="eyebrow">SUBSCRIPTION & USAGE</p>
            <h1>Billing & Plan Management</h1>
          </div>
          {workspaces.length > 0 && (
            <div className="pricing-workspace-bar">
              <label htmlFor="billing-workspace-select">Workspace:</label>
              <select
                id="billing-workspace-select"
                value={selectedWorkspaceId}
                onChange={(e) => handleWorkspaceChange(e.target.value)}
              >
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.role})
                  </option>
                ))}
              </select>
            </div>
          )}
        </header>

        {error && <div className="banner-error">{error}</div>}
        {notice && <div className="banner-success">{notice}</div>}

        {loading ? (
          <SkeletonGrid count={2} />
        ) : !overview ? (
          <div className="panel-card">Create a workspace first to manage subscriptions.</div>
        ) : (
          <>
            {!overview.accessAllowed && overview.accessReason && (
              <div className="banner-warning billing-alert">
                <div>
                  <strong>Action required:</strong> {overview.accessReason}
                </div>
                <Link className="primary-button" href="/pricing">
                  View Plans
                </Link>
              </div>
            )}

            {usage?.nearLimit && (
              <div className="banner-warning billing-alert">
                <div>
                  <strong>Approaching monthly limit:</strong> You have used {usage.complaintsUsed.toLocaleString("en-IN")} of{" "}
                  {usage.monthlyLimit?.toLocaleString("en-IN")} complaints ({usage.percentUsed}%) this month.
                </div>
                <Link className="secondary-button" href="/pricing">
                  Upgrade Plan
                </Link>
              </div>
            )}

            {usage?.limitReached && (
              <div className="banner-error billing-alert">
                <div>
                  <strong>Monthly limit reached:</strong> New complaint submissions are paused until you upgrade or the next monthly cycle begins.
                </div>
                <Link className="primary-button" href="/pricing">
                  Upgrade Now
                </Link>
              </div>
            )}

            <section className="billing-grid">
              <article className="panel-card">
                <div className="billing-card-head">
                  <div>
                    <p className="eyebrow">CURRENT PLAN</p>
                    <h2>{sub ? `${sub.plan.name} Plan` : "No Active Subscription"}</h2>
                  </div>
                  <span className={`status-badge tone-${statusInfo.tone}`}>{statusInfo.label}</span>
                </div>

                {sub ? (
                  <div className="billing-meta-list">
                    <div>
                      <span>Monthly price</span>
                      <strong>{formatInrFromPaise(sub.plan.monthlyPricePaise)} / month</strong>
                    </div>
                    <div>
                      <span>Current billing period</span>
                      <strong>
                        {formatDate(sub.currentPeriodStart)} – {formatDate(sub.currentPeriodEnd)}
                      </strong>
                    </div>
                    <div>
                      <span>Payment provider</span>
                      <strong>Razorpay</strong>
                    </div>
                    {sub.pendingPlan && (
                      <div>
                        <span>Scheduled change</span>
                        <strong>Switches to {sub.pendingPlan.name} at period end</strong>
                      </div>
                    )}
                    {sub.lastPaymentError && (
                      <div className="error-text">
                        <span>Last payment issue</span>
                        <strong>{sub.lastPaymentError}</strong>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted-copy">
                    Select a subscription plan below or visit the{" "}
                    <Link href="/pricing" className="inline-link">
                      Pricing page
                    </Link>{" "}
                    to activate complaint intake for this workspace.
                  </p>
                )}

                {overview.canManageBilling && sub && sub.status === "active" && !sub.cancelAtPeriodEnd && (
                  <div className="billing-actions-row">
                    <button
                      type="button"
                      className="danger-outline-button"
                      disabled={actionBusy}
                      onClick={() => setCancelConfirmOpen(true)}
                    >
                      Cancel subscription
                    </button>
                  </div>
                )}
              </article>

              <article className="panel-card">
                <div className="billing-card-head">
                  <div>
                    <p className="eyebrow">MONTHLY USAGE ({usage?.periodKey})</p>
                    <h2>
                      <AnimatedCounter value={usage?.complaintsUsed ?? 0} />{" "}
                      <span className="muted-inline">
                        / {usage?.monthlyLimit !== null && usage?.monthlyLimit !== undefined ? usage.monthlyLimit.toLocaleString("en-IN") : "Custom"}
                      </span>
                    </h2>
                  </div>
                  <span className="usage-percent">{usage?.percentUsed ?? 0}%</span>
                </div>

                <div className="usage-bar-track" aria-label="Monthly complaint usage">
                  <div
                    className={`usage-bar-fill ${
                      usage?.limitReached ? "danger" : usage?.nearLimit ? "warning" : ""
                    }`}
                    style={{ width: `${Math.min(100, usage?.percentUsed ?? 0)}%` }}
                  />
                </div>

                <p className="muted-copy">
                  {usage?.remaining !== null && usage?.remaining !== undefined
                    ? `${usage.remaining.toLocaleString("en-IN")} complaints remaining before ${formatDate(usage.periodEnd)}.`
                    : "Custom monthly complaint allowance."}
                </p>
              </article>
            </section>

            {overview.canManageBilling && paidPlans.length > 0 && (
              <section className="panel-card">
                <div className="billing-card-head">
                  <div>
                    <p className="eyebrow">SWITCH OR ACTIVATE PLAN</p>
                    <h2>Available Monthly Plans</h2>
                  </div>
                  <Link href="/pricing" className="text-button">
                    Compare all plans
                  </Link>
                </div>

                <div className="plan-switch-grid">
                  {paidPlans.map((plan) => {
                    const isCurrent = sub?.plan.code === plan.code && sub.status === "active";
                    const isUpgrade =
                      sub?.status === "active" &&
                      isUpgradeTransition(sub.plan.monthlyPricePaise, plan.monthlyPricePaise);
                    const buttonLabel = isCurrent
                      ? "Current Plan"
                      : sub?.status === "active"
                        ? isUpgrade
                          ? `Upgrade to ${plan.name}`
                          : `Downgrade to ${plan.name}`
                        : `Subscribe to ${plan.name}`;

                    return (
                      <div key={plan.code} className={`plan-switch-card ${isCurrent ? "current" : ""}`}>
                        <div className="plan-switch-top">
                          <strong>{plan.name}</strong>
                          <span>{formatInrFromPaise(plan.monthlyPricePaise)}/mo</span>
                        </div>
                        <p className="muted-copy">
                          Up to {plan.monthlyComplaintLimit?.toLocaleString("en-IN")} complaints / month
                        </p>
                        <button
                          type="button"
                          className={isCurrent ? "secondary-button" : "primary-button"}
                          disabled={isCurrent || actionBusy}
                          onClick={() => handleSubscribeOrSwitch(plan)}
                        >
                          {buttonLabel}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="panel-card">
              <div className="billing-card-head">
                <div>
                  <p className="eyebrow">TRANSACTIONS</p>
                  <h2>Payment History & Invoices</h2>
                </div>
              </div>

              {overview.transactions.length === 0 ? (
                <p className="muted-copy">No payments recorded for this workspace yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="billing-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Plan</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Payment ID</th>
                        <th>Receipt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.transactions.map((tx) => (
                        <tr key={tx.id}>
                          <td>{formatDate(tx.paid_at ?? tx.created_at)}</td>
                          <td>{tx.plan_name ?? "Subscription"}</td>
                          <td>{formatInrFromPaise(tx.amount_paise)}</td>
                          <td>
                            <span className={`status-badge tone-${tx.status === "captured" ? "success" : tx.status === "failed" ? "danger" : "neutral"}`}>
                              {tx.status}
                            </span>
                          </td>
                          <td className="mono-cell">{tx.provider_payment_id ?? "—"}</td>
                          <td>
                            {tx.invoice_url ? (
                              <a href={tx.invoice_url} target="_blank" rel="noreferrer" className="inline-link">
                                View invoice
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {cancelConfirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-modal-title">
          <div className="modal-panel">
            <h2 id="cancel-modal-title">Cancel subscription?</h2>
            <p className="muted-copy">
              Your workspace will keep full access to your current plan until{" "}
              <strong>{formatDate(sub?.currentPeriodEnd)}</strong>. After that date, recurring billing will stop and no further charges will be made.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setCancelConfirmOpen(false)}>
                Keep subscription
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={actionBusy}
                onClick={handleCancelSubscription}
              >
                {actionBusy ? "Cancelling..." : "Confirm cancellation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
