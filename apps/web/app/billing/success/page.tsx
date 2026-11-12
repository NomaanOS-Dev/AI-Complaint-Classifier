"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function BillingSuccessContent() {
  const params = useSearchParams();
  const workspaceId = params.get("workspaceId") ?? "";
  const plan = params.get("plan") ?? "your selected";

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">PAYMENT VERIFIED</p>
        <h1>Subscription Activated</h1>
        <p className="muted-copy">
          Your payment was verified with Razorpay and your workspace is now active on the <strong>{plan}</strong> plan.
        </p>
        <div className="billing-actions-row">
          <Link className="primary-button" href={workspaceId ? `/billing?workspaceId=${workspaceId}` : "/billing"}>
            Go to Billing Dashboard
          </Link>
          <Link className="secondary-button" href={workspaceId ? `/complaints?workspaceId=${workspaceId}` : "/dashboard"}>
            Open Complaints
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={<div className="auth-shell">Loading...</div>}>
      <BillingSuccessContent />
    </Suspense>
  );
}
