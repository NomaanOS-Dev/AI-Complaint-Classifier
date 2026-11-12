const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && emailPattern.test(trimmed);
}

export function validatePasswordResetInput(password: string, confirmPassword: string): string | null {
  if (password.length < 12 || password.length > 128) {
    return "Password must be between 12 and 128 characters.";
  }
  if (password !== confirmPassword) {
    return "Passwords do not match.";
  }
  return null;
}

export function formatRateLimitMessage(retryAfterHeader: string | null, prefix: string): string {
  const retryAfterSeconds = Number(retryAfterHeader);
  const retryMessage = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds < 60
      ? `Please try again in ${retryAfterSeconds} seconds.`
      : `Please try again in about ${Math.ceil(retryAfterSeconds / 60)} minutes.`
    : "Please wait for the 15-minute limit window to reset before trying again.";
  return `${prefix} ${retryMessage}`;
}
