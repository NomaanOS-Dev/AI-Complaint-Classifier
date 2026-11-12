import { createHash, randomBytes } from "node:crypto";

export interface GoogleUserProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function isGoogleOAuthConfigured(): boolean {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return Boolean(
    clientId &&
    clientId.trim().length > 0 &&
    !clientId.startsWith("replace-") &&
    clientSecret &&
    clientSecret.trim().length > 0 &&
    !clientSecret.startsWith("replace-")
  );
}

export function getGoogleAuthorizationUrl(options: {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is not configured.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: options.state,
    access_type: "online",
    prompt: "select_account"
  });

  if (options.codeChallenge) {
    params.set("code_challenge", options.codeChallenge);
    params.set("code_challenge_method", "S256");
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleAuthorizationCode(options: {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetcher?: typeof fetch;
}): Promise<{ idToken: string; accessToken: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials are not configured on the API.");
  }

  const fetcher = options.fetcher ?? fetch;
  const bodyParams: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code: options.code,
    grant_type: "authorization_code",
    redirect_uri: options.redirectUri
  };

  if (options.codeVerifier) {
    bodyParams.code_verifier = options.codeVerifier;
  }

  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString()
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json() as { id_token?: string; access_token?: string };
  if (!data.id_token) {
    throw new Error("Google token response did not contain an id_token.");
  }

  return { idToken: data.id_token, accessToken: data.access_token ?? "" };
}

export async function verifyGoogleIdToken(
  idToken: string,
  fetcher: typeof fetch = fetch
): Promise<GoogleUserProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is not configured on the API.");
  }

  const response = await fetcher(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!response.ok) {
    throw new Error("Google ID token validation failed or token is expired.");
  }

  const payload = await response.json() as Record<string, unknown>;

  // 1. Audience verification (must match our client ID)
  if (payload.aud !== clientId) {
    throw new Error("Google ID token audience does not match configured GOOGLE_CLIENT_ID.");
  }

  // 2. Issuer verification
  const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
  if (typeof payload.iss !== "string" || !validIssuers.includes(payload.iss)) {
    throw new Error("Google ID token has an invalid issuer.");
  }

  // 3. Expiration verification
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    throw new Error("Google ID token has expired.");
  }

  // 4. Email verification claim
  const isVerified = payload.email_verified === "true" || payload.email_verified === true;
  if (!isVerified) {
    throw new Error("Google email address is not verified by Google.");
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    throw new Error("Google token did not provide a valid email address.");
  }

  const googleId = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!googleId) {
    throw new Error("Google token did not provide a subject ID.");
  }

  const name = typeof payload.name === "string" && payload.name.trim().length > 0
    ? payload.name.trim()
    : email.split("@")[0];

  const picture = typeof payload.picture === "string" ? payload.picture : undefined;

  return {
    googleId,
    email,
    emailVerified: isVerified,
    name,
    picture
  };
}
