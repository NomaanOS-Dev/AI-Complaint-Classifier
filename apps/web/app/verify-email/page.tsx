import { Suspense } from "react";
import { VerifyEmailDashboard } from "../../components/verify-email-dashboard";

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-shell">
          <p className="loading-state">Loading verification…</p>
        </main>
      }
    >
      <VerifyEmailDashboard />
    </Suspense>
  );
}
