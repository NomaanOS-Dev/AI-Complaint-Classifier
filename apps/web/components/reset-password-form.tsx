"use client";

import Link from "next/link";
import { BrandLockup } from "./brand-logo";
import { ThemeToggleButton } from "./theme-provider";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";
import { formatRateLimitMessage, validatePasswordResetInput } from "../lib/password-reset";

export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = (searchParams.get("token") ?? "").trim();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !token) return;
    setError("");

    const validationError = validatePasswordResetInput(password, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    try {
      const { data, response } = await apiRequest<{ success?: boolean; message?: string; error?: string }>(
        "/auth/reset-password",
        {
          method: "POST",
          body: JSON.stringify({ token, password, confirmPassword })
        }
      );

      if (!response.ok && response.status === 429) {
        throw new Error(formatRateLimitMessage(response.headers.get("retry-after"), "Too many password reset attempts."));
      }

      if (!response.ok || !data.success) {
        throw new Error(
          apiErrorMessage(data, "Unable to reset your password. The link may be invalid, expired, or already used.")
        );
      }

      setPassword("");
      setConfirmPassword("");
      setSuccessMessage(
        data.message ?? "Your password has been reset successfully. You can now sign in with your new password."
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reset your password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-top-bar">
        <BrandLockup href="/" />
        <ThemeToggleButton />
      </div>

      <section className="auth-card">
        {!token ? (
          <div className="auth-status-container">
            <div className="status-icon-circle danger">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <p className="eyebrow" style={{ color: "var(--danger)" }}>INVALID LINK</p>
            <h1>Missing reset token</h1>
            <p className="auth-subtitle">
              This password reset link is incomplete or invalid. Request a new password reset link to continue.
            </p>
            <Link className="primary-link form-submit" href="/forgot-password">
              Request new reset link
            </Link>
            <p className="auth-switch">
              <Link href="/login">Back to sign in</Link>
            </p>
          </div>
        ) : successMessage ? (
          <div className="auth-status-container">
            <div className="status-icon-circle success">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="eyebrow" style={{ color: "var(--success)" }}>PASSWORD UPDATED</p>
            <h1>Password reset complete</h1>
            <p className="auth-subtitle">{successMessage}</p>
            <Link className="primary-link form-submit" href="/login" style={{ marginTop: "8px" }}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <p className="eyebrow">CHOOSE NEW PASSWORD</p>
            <h1>Set a new password</h1>
            <p className="auth-subtitle">
              Enter and confirm your new password below. This reset link can only be used once.
            </p>

            <form onSubmit={submit} noValidate>
              <label>
                New password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={128}
                  disabled={busy}
                />
                <small>Use 12–128 characters.</small>
              </label>

              <label>
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={128}
                  disabled={busy}
                />
              </label>

              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}

              <button className="primary-link form-submit" disabled={busy}>
                {busy ? "Resetting password…" : "Reset password"}
              </button>
            </form>

            <p className="auth-switch">
              Need a new link? <Link href="/forgot-password">Request another reset</Link> ·{" "}
              <Link href="/login">Back to sign in</Link>
            </p>
          </>
        )}
      </section>

      <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
    </main>
  );
}
