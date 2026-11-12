import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Resend } from "resend";

export interface VerificationTokenResult {
  rawToken: string;
  expiresAt: Date;
}

export interface VerifyTokenResult {
  success: boolean;
  reason?: "invalid_or_expired" | "database_error";
  user?: {
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
  };
}

async function createSingleUseToken(
  client: PoolClient | Pool,
  table: "email_verification_tokens" | "password_reset_tokens",
  userId: string,
  expiresInMs: number
): Promise<VerificationTokenResult> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + expiresInMs);

  // Invalidate any existing unused tokens for this user
  await client.query(
    `UPDATE ${table}
     SET used_at = now()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  await client.query(
    `INSERT INTO ${table} (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { rawToken, expiresAt };
}

export async function createVerificationToken(
  client: PoolClient | Pool,
  userId: string,
  expiresInMs = 24 * 60 * 60 * 1000
): Promise<VerificationTokenResult> {
  return createSingleUseToken(client, "email_verification_tokens", userId, expiresInMs);
}

export async function createPasswordResetToken(
  client: PoolClient | Pool,
  userId: string,
  expiresInMs = 30 * 60 * 1000
): Promise<VerificationTokenResult> {
  return createSingleUseToken(client, "password_reset_tokens", userId, expiresInMs);
}

export async function verifyEmailToken(
  client: PoolClient | Pool,
  rawToken: string
): Promise<VerifyTokenResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.trim().length < 16) {
    return { success: false, reason: "invalid_or_expired" };
  }

  const tokenHash = createHash("sha256").update(rawToken.trim()).digest("hex");

  const tokenResult = await client.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM email_verification_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );

  const record = tokenResult.rows[0];
  if (!record) {
    return { success: false, reason: "invalid_or_expired" };
  }

  // Mark token as used
  await client.query(
    "UPDATE email_verification_tokens SET used_at = now() WHERE id = $1",
    [record.id]
  );

  // Mark user as email verified
  const userResult = await client.query<{ id: string; name: string; email: string; email_verified: boolean }>(
    `UPDATE users
     SET email_verified = true, email_verified_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, name, email, email_verified`,
    [record.user_id]
  );

  const updatedUser = userResult.rows[0];
  if (!updatedUser) {
    return { success: false, reason: "invalid_or_expired" };
  }

  return { success: true, user: updatedUser };
}

export interface VerificationEmailClient {
  emails: {
    send: (payload: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }) => Promise<{
      data: { id: string } | null;
      error: { message: string; name?: string; statusCode?: number | null } | null;
    }>;
  };
}

export interface SendVerificationEmailResult {
  success: boolean;
  link: string;
  provider: "resend" | "logged";
  error?: string;
}

export interface SendPasswordResetEmailResult {
  success: boolean;
  provider: "resend" | "logged";
  error?: string;
}

function hasConfiguredResendKey(apiKey: string | undefined): apiKey is string {
  return Boolean(apiKey && apiKey.trim().length > 0 && !apiKey.startsWith("replace-"));
}

function renderBrandedEmailHtml(options: { title: string; heading: string; bodyHtml: string }): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(options.title)}</title>
</head>
<body style="background-color: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px;">
  <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px;">
    <tr>
      <td style="padding-bottom: 24px;">
        <span style="font-weight: 700; font-size: 20px; letter-spacing: -0.5px; color: #ffffff;">nomaan<span style="color: #6366f1;">OS</span></span>
      </td>
    </tr>
    <tr>
      <td style="font-size: 16px; line-height: 24px; color: #e6edf3;">
        <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #ffffff;">${escapeHtml(options.heading)}</h2>
        ${options.bodyHtml}
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

async function dispatchViaResend(options: {
  label: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  resendClient?: VerificationEmailClient;
}): Promise<{ success: boolean; error?: string }> {
  const { label, to, subject, text, html, resendClient } = options;
  const resendApiKey = process.env.RESEND_API_KEY;
  try {
    const resend = resendClient ?? new Resend(resendApiKey);
    const from = process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL || "NomaanOS <onboarding@resend.dev>";
    const response = await resend.emails.send({ from, to, subject, text, html });

    if (response?.error) {
      const errorDetails = [
        response.error.name,
        response.error.statusCode != null ? `status ${response.error.statusCode}` : undefined,
        response.error.message
      ]
        .filter(Boolean)
        .join(" - ");
      const errorMessage = errorDetails || "Unknown Resend rejection";
      console.error(`[Email Service] Resend rejected ${label} for ${to}: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }

    if (!response?.data?.id) {
      const errorMessage = "Resend returned an empty response without a message ID";
      console.error(`[Email Service] ${label} delivery for ${to} failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }

    console.info(`[Email Service] ${label} dispatched to ${to} via Resend (id: ${response.data.id}).`);
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Email Service] Unexpected error dispatching ${label} for ${to}: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function sendVerificationEmail(options: {
  to: string;
  name: string;
  rawToken: string;
  customBaseUrl?: string;
  resendClient?: VerificationEmailClient;
}): Promise<SendVerificationEmailResult> {
  const { to, name, rawToken, customBaseUrl, resendClient } = options;
  const webOrigin = customBaseUrl || process.env.WEB_ORIGIN || "http://localhost:3000";
  const verificationLink = `${webOrigin.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(rawToken)}`;

  const subject = "Verify your email for NomaanOS";
  const textContent = `Hello ${name},

Thank you for registering with NomaanOS. Please verify your email address to access your workspace.

Click the link below to verify your email address:
${verificationLink}

This verification link will expire in 24 hours.

If you did not create an account on NomaanOS, please disregard this email.
`;

  const htmlContent = renderBrandedEmailHtml({
    title: "Verify your email - NomaanOS",
    heading: "Verify your email address",
    bodyHtml: `
        <p style="margin: 0 0 16px 0;">Hello ${escapeHtml(name)},</p>
        <p style="margin: 0 0 24px 0;">Thank you for registering with NomaanOS. Confirm your email address to activate your account and start managing your workspace.</p>
        <div style="margin: 32px 0;">
          <a href="${verificationLink}" style="background-color: #6366f1; color: #ffffff; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 15px; text-decoration: none; display: inline-block;">Verify Email Address &rarr;</a>
        </div>
        <p style="margin: 24px 0 8px 0; font-size: 13px; color: #8b949e;">Or copy and paste this verification link into your browser:</p>
        <p style="margin: 0 0 24px 0; font-size: 12px; color: #58a6ff; word-break: break-all;">${verificationLink}</p>
        <p style="margin: 0; font-size: 13px; color: #8b949e;">This link is valid for 24 hours. If you did not create this account, no further action is required.</p>`
  });

  if (resendClient || hasConfiguredResendKey(process.env.RESEND_API_KEY)) {
    const dispatch = await dispatchViaResend({
      label: "Verification email",
      to,
      subject,
      text: textContent,
      html: htmlContent,
      resendClient
    });
    return {
      success: dispatch.success,
      link: verificationLink,
      provider: "resend",
      ...(dispatch.error ? { error: dispatch.error } : {})
    };
  }

  // Fallback for local development, staging, or unconfigured email provider
  console.info(`[Email Service] Development/Local mode: Verification link for ${to}:\n${verificationLink}`);
  return { success: true, link: verificationLink, provider: "logged" };
}

export async function sendPasswordResetEmail(options: {
  to: string;
  name: string;
  rawToken: string;
  customBaseUrl?: string;
  resendClient?: VerificationEmailClient;
}): Promise<SendPasswordResetEmailResult> {
  const { to, name, rawToken, customBaseUrl, resendClient } = options;
  const webOrigin = customBaseUrl || process.env.WEB_ORIGIN || "http://localhost:3000";
  const resetUrl = `${webOrigin.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}`;

  const subject = "Reset your password for NomaanOS";
  const textContent = `Hello ${name},

We received a request to reset the password for your NomaanOS account.

Click the link below to set a new password:
${resetUrl}

This password reset link will expire in 30 minutes and can only be used once.

If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
`;

  const htmlContent = renderBrandedEmailHtml({
    title: "Reset your password - NomaanOS",
    heading: "Reset your password",
    bodyHtml: `
        <p style="margin: 0 0 16px 0;">Hello ${escapeHtml(name)},</p>
        <p style="margin: 0 0 24px 0;">We received a request to reset the password for your NomaanOS account. Click the button below to choose a new password.</p>
        <div style="margin: 32px 0;">
          <a href="${resetUrl}" style="background-color: #6366f1; color: #ffffff; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 15px; text-decoration: none; display: inline-block;">Reset Password &rarr;</a>
        </div>
        <p style="margin: 24px 0 8px 0; font-size: 13px; color: #8b949e;">Or copy and paste this reset link into your browser:</p>
        <p style="margin: 0 0 24px 0; font-size: 12px; color: #58a6ff; word-break: break-all;">${resetUrl}</p>
        <p style="margin: 0 0 12px 0; font-size: 13px; color: #8b949e;"><strong>This link will expire in 30 minutes</strong> and can only be used once.</p>
        <p style="margin: 0; font-size: 13px; color: #8b949e;">If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>`
  });

  if (resendClient || hasConfiguredResendKey(process.env.RESEND_API_KEY)) {
    const dispatch = await dispatchViaResend({
      label: "Password reset email",
      to,
      subject,
      text: textContent,
      html: htmlContent,
      resendClient
    });
    return {
      success: dispatch.success,
      provider: "resend",
      ...(dispatch.error ? { error: dispatch.error } : {})
    };
  }

  console.warn(`[Email Service] Password reset email not sent for ${to}: RESEND_API_KEY is not configured.`);
  return { success: false, provider: "logged", error: "RESEND_API_KEY is not configured" };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
