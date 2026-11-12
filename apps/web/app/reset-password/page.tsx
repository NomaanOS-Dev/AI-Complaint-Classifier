import { Suspense } from "react";
import { ResetPasswordForm } from "../../components/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-shell">
          <p className="loading-state">Loading password reset…</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
