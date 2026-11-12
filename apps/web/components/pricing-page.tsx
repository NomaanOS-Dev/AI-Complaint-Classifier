"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { formatInrFromPaise, type PlanCode, type SubscriptionPlan } from "../lib/billing";
import { loadRazorpayCheckoutScript } from "../lib/razorpay";
import { TwoLayerNavbar } from "./brand-logo";
import { Reveal } from "./motion-primitives";

type WorkspaceItem = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
};

const FALLBACK_PLANS: SubscriptionPlan[] = [
  {
    id: "starter",
    code: "starter",
    name: "Starter",
    tagline: "Essential AI complaint triage for small teams.",
    targetAudience: "Small businesses",
    monthlyPricePaise: 99900,
    currency: "INR",
    billingInterval: "monthly",
    monthlyComplaintLimit: 500,
    maxWorkspaces: 1,
    isPopular: false,
    isCustom: false,
    features: [
      "1 workspace",
      "Maximum 500 complaints per month",
      "AI complaint classification",
      "Complaint management dashboard",
      "Basic reports",
      "Standard support"
    ]
  },
  {
    id: "growth",
    code: "growth",
    name: "Growth",
    tagline: "Advanced analytics and team workflows for scaling support.",
    targetAudience: "Growing businesses",
    monthlyPricePaise: 249900,
    currency: "INR",
    billingInterval: "monthly",
    monthlyComplaintLimit: 2500,
    maxWorkspaces: 3,
    isPopular: true,
    isCustom: false,
    features: [
      "Up to 2,500 complaints per month",
      "Everything in Starter",
      "Advanced analytics",
      "Team access",
      "Priority support"
    ]
  },
  {
    id: "business",
    code: "business",
    name: "Business",
    tagline: "High-volume automation, multiple teams, and custom reporting.",
    targetAudience: "Larger businesses",
    monthlyPricePaise: 599900,
    currency: "INR",
    billingInterval: "monthly",
    monthlyComplaintLimit: 10000,
    maxWorkspaces: 10,
    isPopular: false,
    isCustom: false,
    features: [
      "Up to 10,000 complaints per month",
      "Everything in Growth",
      "Advanced workflow options",
      "Multiple teams",
      "Custom reports"
    ]
  },
  {
    id: "enterprise",
    code: "enterprise",
    name: "Enterprise",
    tagline: "Tailored limits, integrations, and dedicated onboarding.",
    targetAudience: "Large organisations",
    monthlyPricePaise: null,
    currency: "INR",
    billingInterval: "custom",
    monthlyComplaintLimit: null,
    maxWorkspaces: null,
    isPopular: false,
    isCustom: true,
    features: [
      "Custom complaint limits",
      "Custom integrations",
      "Dedicated support",
      "Custom workflows",
      "Contact Sales option"
    ]
  }
];

export default function PricingPageClient() {
  const router = useRouter();
  const [plans, setPlans] = useState<SubscriptionPlan[]>(FALLBACK_PLANS);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [busyPlan, setBusyPlan] = useState<PlanCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [salesOpen, setSalesOpen] = useState(false);
  const [salesName, setSalesName] = useState("");
  const [salesEmail, setSalesEmail] = useState("");
  const [salesCompany, setSalesCompany] = useState("");
  const [salesPhone, setSalesPhone] = useState("");
  const [salesVolume, setSalesVolume] = useState("10,000+ complaints / month");
  const [salesMessage, setSalesMessage] = useState("");
  const [salesSubmitting, setSalesSubmitting] = useState(false);
  const [salesSuccess, setSalesSuccess] = useState<string | null>(null);
  const [salesError, setSalesError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const plansRes = await apiRequest<{ plans?: SubscriptionPlan[] }>("/billing/plans");
      if (active && plansRes.response.ok && Array.isArray(plansRes.data.plans) && plansRes.data.plans.length > 0) {
        setPlans(plansRes.data.plans);
      }

      const meRes = await apiRequest<{ user?: { name: string; email: string } }>("/auth/me");
      if (active && meRes.response.ok && meRes.data.user) {
        setSignedIn(true);
        setSalesName(meRes.data.user.name || "");
        setSalesEmail(meRes.data.user.email || "");
        const wsRes = await apiRequest<{ workspaces?: WorkspaceItem[] }>("/workspaces");
        if (active && wsRes.response.ok && Array.isArray(wsRes.data.workspaces)) {
          setWorkspaces(wsRes.data.workspaces);
          const manageable = wsRes.data.workspaces.find((w) => w.role === "owner" || w.role === "admin");
          if (manageable) setSelectedWorkspaceId(manageable.id);
          else if (wsRes.data.workspaces[0]) setSelectedWorkspaceId(wsRes.data.workspaces[0].id);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubscribe(plan: SubscriptionPlan) {
    setError(null);
    setStatusMessage(null);

    if (plan.isCustom || plan.code === "enterprise") {
      setSalesOpen(true);
      return;
    }

    if (!signedIn) {
      router.push(`/register?plan=${plan.code}`);
      return;
    }

    if (!selectedWorkspaceId) {
      setError("Create or select a workspace on your dashboard before subscribing.");
      return;
    }

    setBusyPlan(plan.code);
    try {
      const res = await apiRequest<{
        checkout?: {
          keyId: string;
          subscriptionId: string;
          name: string;
          description: string;
          prefill?: { name?: string; email?: string };
        };
        code?: string;
        error?: string;
      }>(`/workspaces/${selectedWorkspaceId}/billing/subscribe`, {
        method: "POST",
        body: JSON.stringify({ planCode: plan.code })
      });

      if (!res.response.ok) {
        if (res.data.code === "USE_PLAN_CHANGE" || res.data.code === "ALREADY_SUBSCRIBED") {
          router.push(`/billing?workspaceId=${selectedWorkspaceId}&plan=${plan.code}`);
          return;
        }
        setError(apiErrorMessage(res.data, "Could not start subscription checkout."));
        return;
      }

      const checkout = res.data.checkout;
      if (!checkout) {
        setError("Server did not return Razorpay checkout details.");
        return;
      }

      const scriptLoaded = await loadRazorpayCheckoutScript();
      if (!scriptLoaded || !window.Razorpay) {
        setError("Failed to load Razorpay Checkout script. Check your network connection and try again.");
        return;
      }

      const rz = new window.Razorpay({
        key: checkout.keyId,
        subscription_id: checkout.subscriptionId,
        name: checkout.name,
        description: checkout.description,
        prefill: checkout.prefill,
        theme: { color: "#6366f1" },
        handler: async (paymentResponse) => {
          setStatusMessage("Verifying your payment securely...");
          const verifyRes = await apiRequest<{ verified?: boolean }>(`/workspaces/${selectedWorkspaceId}/billing/verify-payment`, {
            method: "POST",
            body: JSON.stringify(paymentResponse)
          });
          if (verifyRes.response.ok && verifyRes.data.verified) {
            router.push(
              `/billing/success?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&plan=${encodeURIComponent(plan.name)}`
            );
          } else {
            router.push(
              `/billing/failure?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&reason=${encodeURIComponent(
                apiErrorMessage(verifyRes.data, "Payment signature verification failed.")
              )}`
            );
          }
        },
        modal: {
          ondismiss: () => {
            setBusyPlan(null);
            setStatusMessage("Checkout was closed before completing payment.");
          }
        }
      });

      rz.on("payment.failed", (evt) => {
        const reason = evt?.error?.description || evt?.error?.reason || "Payment was declined.";
        router.push(
          `/billing/failure?workspaceId=${encodeURIComponent(selectedWorkspaceId)}&reason=${encodeURIComponent(reason)}`
        );
      });

      rz.open();
    } finally {
      setBusyPlan(null);
    }
  }

  async function submitEnterpriseInquiry(e: React.FormEvent) {
    e.preventDefault();
    setSalesError(null);
    setSalesSuccess(null);
    setSalesSubmitting(true);
    try {
      const res = await apiRequest<{ message?: string }>("/billing/enterprise-inquiry", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: selectedWorkspaceId || undefined,
          name: salesName,
          email: salesEmail,
          company: salesCompany,
          phone: salesPhone || undefined,
          expectedMonthlyComplaints: salesVolume,
          message: salesMessage
        })
      });
      if (!res.response.ok) {
        setSalesError(apiErrorMessage(res.data, "Please complete all required fields."));
        return;
      }
      setSalesSuccess(res.data.message ?? "Our enterprise team will reach out shortly.");
      setSalesMessage("");
    } finally {
      setSalesSubmitting(false);
    }
  }

  return (
    <div className="pricing-shell">
      <TwoLayerNavbar>
        <Link className="text-button" href="/">Home</Link>
        <Link className="text-button" href="/docs">Docs</Link>
        {signedIn ? (
          <>
            <Link className="text-button" href="/dashboard">Dashboard</Link>
            <Link className="primary-button" href={selectedWorkspaceId ? `/billing?workspaceId=${selectedWorkspaceId}` : "/billing"}>
              Billing
            </Link>
          </>
        ) : (
          <>
            <Link className="text-button" href="/login">Sign in</Link>
            <Link className="primary-button" href="/register">Create account</Link>
          </>
        )}
      </TwoLayerNavbar>

      <main className="pricing-main">
        <header className="pricing-hero">
          <p className="eyebrow">TRANSPARENT SAAS PRICING</p>
          <h1>Plans built for every stage of customer support.</h1>
          <p className="lead">
            Automate complaint classification, sentiment scoring, and reply drafting with predictable monthly INR pricing powered by Razorpay.
          </p>

          {signedIn && workspaces.length > 0 && (
            <div className="pricing-workspace-bar">
              <label htmlFor="pricing-workspace-select">Workspace to subscribe:</label>
              <select
                id="pricing-workspace-select"
                value={selectedWorkspaceId}
                onChange={(e) => setSelectedWorkspaceId(e.target.value)}
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
        {statusMessage && <div className="banner-info">{statusMessage}</div>}

        <section className="pricing-grid" aria-label="Subscription plans">
          {plans.map((plan, idx) => (
            <Reveal key={plan.code} delay={idx * 75}>
              <article
                className={`pricing-card interactive-card ${plan.isPopular ? "popular" : ""}`}
              >
              <div className="pricing-card-head">
                <div className="pricing-title-row">
                  <h2>{plan.name}</h2>
                  {plan.isPopular && <span className="popular-badge">Most Popular</span>}
                </div>
                <p className="pricing-target">{plan.targetAudience}</p>
                <div className="pricing-price-row">
                  <span className="pricing-price">{formatInrFromPaise(plan.monthlyPricePaise)}</span>
                  {plan.monthlyPricePaise !== null && <span className="pricing-period">/month</span>}
                </div>
                <p className="pricing-tagline">{plan.tagline}</p>
              </div>

              <div className="pricing-limit-pill">
                {plan.monthlyComplaintLimit !== null
                  ? `Up to ${plan.monthlyComplaintLimit.toLocaleString("en-IN")} complaints / month`
                  : "Custom monthly complaint volume"}
              </div>

              <ul className="pricing-features">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <span className="check-dot" aria-hidden="true">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="pricing-card-footer">
                {plan.isCustom ? (
                  <button
                    type="button"
                    className="secondary-button full-width"
                    onClick={() => setSalesOpen(true)}
                  >
                    Contact Sales
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${plan.isPopular ? "primary-button" : "secondary-button"} full-width`}
                    disabled={busyPlan !== null}
                    onClick={() => handleSubscribe(plan)}
                  >
                    {busyPlan === plan.code ? "Starting checkout..." : signedIn ? `Subscribe to ${plan.name}` : `Get started with ${plan.name}`}
                  </button>
                )}
              </div>
              </article>
            </Reveal>
          ))}
        </section>

        <section className="pricing-faq">
          <div className="pricing-faq-card">
            <h3>How monthly limits work</h3>
            <p>
              Complaint usage is counted per workspace each calendar month across manual submissions, API integrations, and public contact forms. You will receive an in-app alert at 80% usage and can upgrade immediately at any time.
            </p>
          </div>
          <div className="pricing-faq-card">
            <h3>Secure Razorpay recurring billing</h3>
            <p>
              Payments are processed securely via Razorpay in INR (UPI, Cards, NetBanking). NomaanOS never stores raw card details and verifies every transaction server-side.
            </p>
          </div>
        </section>
      </main>

      {salesOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="enterprise-modal-title">
          <div className="modal-panel">
            <div className="modal-head">
              <div>
                <p className="eyebrow">ENTERPRISE PLAN</p>
                <h2 id="enterprise-modal-title">Contact Sales</h2>
              </div>
              <button type="button" className="text-button" onClick={() => setSalesOpen(false)}>
                Close
              </button>
            </div>
            <p className="muted-copy">
              Tell us about your expected monthly complaint volume and custom integration requirements.
            </p>

            {salesError && <div className="banner-error">{salesError}</div>}
            {salesSuccess && <div className="banner-success">{salesSuccess}</div>}

            <form className="stack-form" onSubmit={submitEnterpriseInquiry}>
              <label>
                Full name
                <input
                  type="text"
                  required
                  value={salesName}
                  onChange={(e) => setSalesName(e.target.value)}
                  placeholder="Aarav Sharma"
                />
              </label>
              <label>
                Work email
                <input
                  type="email"
                  required
                  value={salesEmail}
                  onChange={(e) => setSalesEmail(e.target.value)}
                  placeholder="aarav@company.com"
                />
              </label>
              <label>
                Company / Organisation
                <input
                  type="text"
                  required
                  value={salesCompany}
                  onChange={(e) => setSalesCompany(e.target.value)}
                  placeholder="Acme Support Pvt Ltd"
                />
              </label>
              <label>
                Expected monthly complaints
                <input
                  type="text"
                  value={salesVolume}
                  onChange={(e) => setSalesVolume(e.target.value)}
                  placeholder="e.g. 25,000+ complaints / month"
                />
              </label>
              <label>
                Requirements
                <textarea
                  rows={4}
                  required
                  value={salesMessage}
                  onChange={(e) => setSalesMessage(e.target.value)}
                  placeholder="Describe your teams, custom integrations, SLA, or workflow requirements..."
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="text-button" onClick={() => setSalesOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={salesSubmitting}>
                  {salesSubmitting ? "Sending..." : "Submit inquiry"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
