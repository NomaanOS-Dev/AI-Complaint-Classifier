import { Suspense } from "react";
import BillingDashboard from "../../components/billing-dashboard";

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="panel-card">Loading billing...</div>}>
      <BillingDashboard />
    </Suspense>
  );
}
