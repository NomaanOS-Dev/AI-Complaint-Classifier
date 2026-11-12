"use client";

import Link from "next/link";
import { BrandLockup } from "./brand-logo";
import { ThemeToggleButton } from "./theme-provider";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api";

export function VerifyEmailDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const tokenParam = searchParams.get("token");
  const emailParam = searchParams.get("email") ?? "";

  const [email, setEmail] = useState(emailParam);
  const [userName, setUserName] = useState<string>("");
  const [isAlreadyVerified, setIsAlreadyVerified] = useState(false);

  // States: "initial", "verifying", "verified", "verify_error"
  const [verificationState, setVerificationState] = useState<"initial" | "verifying" | "verified" | "verify_error">(
    tokenParam ? "verifying" : "initial"
  );
  const [verificationError, setVerificationError] = useState("");

  // Resend state
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState("");
  const [resendError, setResendError] = useState("");

  // Change email state
  const [showChangeEmail, setShowChangeEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [changingEmail, setChangingEmail] = useState(false);
  const [changeEmailNotice, setChangeEmailNotice] = useState("");
  const [changeEmailError, setChangeEmailError] = useState("");

  // 1. Fetch current user info if logged in
  useEffect(() => {
    let mounted = true;
    apiRequest<{ user: { id: string; name: string; email: string; email_verified: boolean } }>("/auth/me")
      .then(({ data, response }) => {
        if (!mounted) return;
        if (response.ok && data.user) {
          setEmail((prev) => prev || data.user.email);
          setUserName(data.user.name);
          if (data.user.email_verified) {
            setIsAlreadyVerified(true);
          }
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
    };
  }, []);

  // 2. Cooldown timer for resend
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  // 3. Auto-verify if token is in query param
  useEffect(() => {
    if (!tokenParam) return;

    let mounted = true;
    async function verifyToken() {
      setVerificationState("verifying");
      setVerificationError("");
      try {
        const { data, response } = await apiRequest<{
          success?: boolean;
          message?: string;
          error?: string;
          user?: { email: string };
        }>("/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ token: tokenParam })
        });

        if (!mounted) return;

        if (!response.ok || !data.success) {
          throw new Error(apiErrorMessage(data, "Verification link is invalid, expired, or already used."));
        }

        if (data.user?.email) {
          setEmail(data.user.email);
        }
        setVerificationState("verified");
      } catch (err) {
        if (!mounted) return;
        setVerificationError(err instanceof Error ? err.message : "Verification failed.");
        setVerificationState("verify_error");
      }
    }

    void verifyToken();

    return () => {
      mounted = false;
    };
  }, [tokenParam]);

  async function handleResend() {
    if (resending || resendCooldown > 0) return;
    setResending(true);
    setResendError("");
    setResendMessage("");

    try {
      const { data, response } = await apiRequest<{ message?: string; error?: string }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: email || undefined })
      });

      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Failed to resend verification email."));
      }

      setResendMessage(data.message ?? "A new verification email has been sent. Please check your inbox.");
      setResendCooldown(60);
    } catch (err) {
      setResendError(err instanceof Error ? err.message : "Failed to send email.");
    } finally {
      setResending(false);
    }
  }

  async function handleChangeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changingEmail) return;
    setChangingEmail(true);
    setChangeEmailError("");
    setChangeEmailNotice("");

    try {
      const { data, response } = await apiRequest<{ message?: string; email?: string; error?: string }>(
        "/auth/change-email",
        {
          method: "POST",
          body: JSON.stringify({ newEmail: newEmail.trim() })
        }
      );

      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Failed to update email address."));
      }

      setEmail(data.email ?? newEmail.trim());
      setChangeEmailNotice(data.message ?? "Email updated. A new verification link has been sent.");
      setNewEmail("");
      setShowChangeEmail(false);
      setResendCooldown(60);
    } catch (err) {
      setChangeEmailError(err instanceof Error ? err.message : "Failed to change email.");
    } finally {
      setChangingEmail(false);
    }
  }

  async function handleLogout() {
    await apiRequest("/auth/logout", { method: "POST", body: "{}" });
    router.replace("/login");
  }

  return (
    <main className="auth-shell">
      <div className="auth-top-bar">
        <BrandLockup href="/" />
        <ThemeToggleButton />
      </div>

      <section className="auth-card verification-card">
        {/* State 1: Verifying incoming token */}
        {verificationState === "verifying" && (
          <div className="auth-status-container">
            <div className="auth-spinner" />
            <h1>Verifying your email…</h1>
            <p className="auth-subtitle">Validating your single-use verification link.</p>
          </div>
        )}

        {/* State 2: Verification Successful */}
        {verificationState === "verified" && (
          <div className="auth-status-container">
            <div className="status-icon-circle success">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="eyebrow" style={{ color: "var(--success)" }}>VERIFIED</p>
            <h1>Email Confirmed!</h1>
            <p className="auth-subtitle">
              Thank you{userName ? `, ${userName}` : ""}. Your email address{email ? ` (${email})` : ""} has been verified. You now have full access to NomaanOS workspaces and features.
            </p>
            <Link className="primary-link form-submit" href="/dashboard" style={{ marginTop: "16px" }}>
              Continue to Dashboard <span>↗</span>
            </Link>
          </div>
        )}

        {/* State 3: Verification Failed */}
        {verificationState === "verify_error" && (
          <div className="auth-status-container">
            <div className="status-icon-circle danger">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <p className="eyebrow" style={{ color: "var(--danger)" }}>INVALID OR EXPIRED</p>
            <h1>Verification Failed</h1>
            <p className="form-error" role="alert" style={{ marginTop: "8px", marginBottom: "16px" }}>
              {verificationError}
            </p>
            <p className="auth-subtitle">
              Verification links are single-use and expire after 30 minutes. Request a new link below to activate your account.
            </p>
            <button
              type="button"
              className="primary-link form-submit"
              onClick={() => {
                setVerificationState("initial");
                void handleResend();
              }}
              disabled={resending || resendCooldown > 0}
            >
              {resendCooldown > 0 ? `Wait ${resendCooldown}s to resend` : "Send new verification link"}
            </button>
          </div>
        )}

        {/* State 4: Already Verified Notice */}
        {verificationState === "initial" && isAlreadyVerified && (
          <div className="auth-status-container">
            <div className="status-icon-circle success">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1>Your email is verified</h1>
            <p className="auth-subtitle">
              {email ? `Account for ${email} is fully verified.` : "Your account is active."}
            </p>
            <Link className="primary-link form-submit" href="/dashboard" style={{ marginTop: "16px" }}>
              Open Dashboard <span>↗</span>
            </Link>
          </div>
        )}

        {/* State 5: Initial / Pending Verification State */}
        {verificationState === "initial" && !isAlreadyVerified && (
          <>
            <div className="mail-icon-badge">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <p className="eyebrow">MANDATORY EMAIL VERIFICATION</p>
            <h1>Check your inbox</h1>
            <p className="auth-subtitle">
              We sent a verification link to your registered email address:
            </p>

            <div className="email-display-box">
              <code>{email || "your registered email"}</code>
            </div>

            <p className="verification-instruction">
              Click the link in the message to activate your account and access your dashboard. Links expire in 30 minutes.
            </p>

            {resendMessage && (
              <p className="form-notice" role="status" style={{ marginBottom: "16px" }}>
                {resendMessage}
              </p>
            )}
            {changeEmailNotice && (
              <p className="form-notice" role="status" style={{ marginBottom: "16px" }}>
                {changeEmailNotice}
              </p>
            )}
            {resendError && (
              <p className="form-error" role="alert" style={{ marginBottom: "16px" }}>
                {resendError}
              </p>
            )}

            <div className="verification-actions">
              <button
                type="button"
                className="filter-button resend-btn"
                onClick={() => void handleResend()}
                disabled={resending || resendCooldown > 0}
              >
                {resending
                  ? "Sending email…"
                  : resendCooldown > 0
                  ? `Resend link (${resendCooldown}s)`
                  : "Resend verification email"}
              </button>

              <button
                type="button"
                className="text-button change-email-toggle"
                onClick={() => setShowChangeEmail(!showChangeEmail)}
              >
                {showChangeEmail ? "Cancel email change" : "Wrong email address?"}
              </button>
            </div>

            {showChangeEmail && (
              <form className="change-email-form" onSubmit={(e) => void handleChangeEmail(e)}>
                <label>
                  New email address
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    required
                    maxLength={254}
                    placeholder="name@company.com"
                  />
                </label>
                {changeEmailError && (
                  <p className="form-error" role="alert">
                    {changeEmailError}
                  </p>
                )}
                <button className="filter-button" disabled={changingEmail}>
                  {changingEmail ? "Updating…" : "Update & Send New Link"}
                </button>
              </form>
            )}

            <div className="auth-switch" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px solid var(--border)" }}>
              <button type="button" className="text-button" onClick={() => void handleLogout()}>
                Log out and sign in with another account
              </button>
            </div>
          </>
        )}
      </section>

      <p className="auth-foot">Private by design. Your workspace belongs to your team.</p>
    </main>
  );
}
