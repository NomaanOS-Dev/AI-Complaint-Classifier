"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function BillingFailureContent() {
  const params = useSearchParams();
  const workspaceId = params.get("workspaceId") ?? "";
  const reason = params.get("reason") ?? "The payment could not be completed or verified.";

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">PAYMENT INCOMPLETE</p>
        <h1>Payment Not Completed</h1>
        <p className="muted-copy">{reason}</p>
        <div className="billing-actions-row">
          <Link className="primary-button" href={workspaceId ? `/billing?workspaceId=${workspaceId}` : "/pricing"}>
            Retry Payment
          </Link>
          <Link className="secondary-button" href="/pricing">
            Back to Pricing
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BillingFailurePage() {
  return (
    <Suspense fallback={<div className="auth-shell">Loading...</div>}>
      <BillingFailureContent />
    </Suspense>
  );
}
