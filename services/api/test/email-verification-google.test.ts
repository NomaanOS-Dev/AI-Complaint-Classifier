import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import dotenv from "dotenv";
import pg from "pg";
import { createVerificationToken } from "../src/email-service.js";
import { getGoogleAuthorizationUrl, verifyGoogleIdToken } from "../src/google-auth.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });
process.env.SESSION_SECRET ??= randomBytes(48).toString("base64");

if (!existsSync("/.dockerenv") && process.env.DATABASE_URL) {
  const localTestUrl = new URL(process.env.DATABASE_URL);
  if (localTestUrl.hostname === "db") {
    localTestUrl.hostname = "127.0.0.1";
    localTestUrl.port = process.env.POSTGRES_PORT ?? "5435";
    process.env.DATABASE_URL = localTestUrl.toString();
  }
}

const { Pool } = pg;
const schema = `nomaanos_ev_${process.pid}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
let testPool: InstanceType<typeof Pool>;
let server: Server;
let baseUrl: string;
let createdSchema = false;

class ApiClient {
  cookie = "";
  csrfToken = "";

  constructor(private readonly origin = baseUrl) {}

  private remember(response: Response) {
    const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
  }

  async request(pathname: string, method = "GET", body?: unknown, csrf = ["POST", "PATCH", "DELETE"].includes(method)) {
    if (csrf && !this.csrfToken) {
      const tokenHeaders: Record<string, string> = { origin: "http://localhost:3000" };
      if (this.cookie) tokenHeaders.cookie = this.cookie;
      const tokenResponse = await fetch(`${this.origin}/auth/csrf`, { headers: tokenHeaders });
      this.remember(tokenResponse);
      this.csrfToken = ((await tokenResponse.json()) as { csrfToken: string }).csrfToken;
    }
    const headers: Record<string, string> = { origin: "http://localhost:3000" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf) headers["x-csrf-token"] = this.csrfToken;

    const response = await fetch(`${this.origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    this.remember(response);
    const responseBody = response.status === 204 ? {} : ((await response.json()) as Record<string, any>);
    if (typeof responseBody.csrfToken === "string") this.csrfToken = responseBody.csrfToken;
    return { status: response.status, body: responseBody, headers: response.headers };
  }
}

describe("Google OAuth, mandatory email verification, and security controls", () => {
  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must be defined");
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;

    const testUrl = new URL(process.env.DATABASE_URL!);
    testUrl.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = testUrl.toString();

    const { migrate, pool } = await import("../src/db.js");
    testPool = pool;
    await migrate();

    const { createApp } = await import("../src/app.js");
    server = createHttpServer(createApp());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (testPool) await testPool.end();
    if (createdSchema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  test("email registration creates unverified user and returns verificationRequired", async () => {
    const client = new ApiClient(baseUrl);
    const email = `unverified.${process.pid}@example.test`;
    const res = await client.request("/auth/register", "POST", {
      name: "Unverified User",
      email,
      password: "SuperSecretPassword123!",
      workspaceName: "Unverified Workspace"
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email_verified, false);
    assert.equal(res.body.verificationRequired, true);

    const tokenRows = await testPool.query(
      "SELECT user_id, used_at, expires_at FROM email_verification_tokens WHERE user_id = $1",
      [res.body.user.id]
    );
    assert.equal(tokenRows.rowCount, 1);
    assert.equal(tokenRows.rows[0].used_at, null);
  });

  test("unverified user is blocked from workspace resources with 403 EMAIL_NOT_VERIFIED", async () => {
    const client = new ApiClient(baseUrl);
    const email = `blocked.${process.pid}@example.test`;
    const reg = await client.request("/auth/register", "POST", {
      name: "Blocked User",
      email,
      password: "SuperSecretPassword123!",
      workspaceName: "Blocked Workspace"
    });
    assert.equal(reg.status, 201);

    const listRes = await client.request("/workspaces");
    assert.equal(listRes.status, 403);
    assert.equal(listRes.body.code, "EMAIL_NOT_VERIFIED");

    const createRes = await client.request("/workspaces", "POST", { name: "Illegal Workspace" });
    assert.equal(createRes.status, 403);
    assert.equal(createRes.body.code, "EMAIL_NOT_VERIFIED");
  });

  test("POST /auth/verify-email validates token, marks email_verified, and enables workspace access", async () => {
    const client = new ApiClient(baseUrl);
    const email = `verify-me.${process.pid}@example.test`;
    const reg = await client.request("/auth/register", "POST", {
      name: "Verify Me",
      email,
      password: "SuperSecretPassword123!",
      workspaceName: "Verify Workspace"
    });
    assert.equal(reg.status, 201);
    const userId = reg.body.user.id;

    const invalidRes = await client.request("/auth/verify-email", "POST", { token: "invalid-token-12345" });
    assert.equal(invalidRes.status, 400);

    const { rawToken } = await createVerificationToken(testPool, userId);

    const verifyRes = await client.request("/auth/verify-email", "POST", { token: rawToken });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.body.success, true);
    assert.equal(verifyRes.body.user.email_verified, true);

    const reuseRes = await client.request("/auth/verify-email", "POST", { token: rawToken });
    assert.equal(reuseRes.status, 400);

    const userRow = await testPool.query("SELECT email_verified, email_verified_at FROM users WHERE id = $1", [userId]);
    assert.equal(userRow.rows[0].email_verified, true);
    assert.ok(userRow.rows[0].email_verified_at instanceof Date);

    const listRes = await client.request("/workspaces");
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.workspaces.length, 1);
  });

  test("resend verification enforces 60-second rate limit and prevents account enumeration", async () => {
    const client = new ApiClient(baseUrl);
    const email = `resend.${process.pid}@example.test`;
    const reg = await client.request("/auth/register", "POST", {
      name: "Resend User",
      email,
      password: "SuperSecretPassword123!",
      workspaceName: "Resend Workspace"
    });
    assert.equal(reg.status, 201);

    const immediateRes = await client.request("/auth/resend-verification", "POST", { email });
    assert.equal(immediateRes.status, 429);
    assert.match(immediateRes.body.error, /wait at least 60 seconds/i);

    const guestClient = new ApiClient(baseUrl);
    const enumRes = await guestClient.request("/auth/resend-verification", "POST", { email: "nonexistent-999@example.com" });
    assert.equal(enumRes.status, 200);
    assert.match(enumRes.body.message, /If an account exists/i);
  });

  test("change email updates unverified user, rejects duplicates, and blocks already verified users", async () => {
    const client = new ApiClient(baseUrl);
    const email = `typo.${process.pid}@example.test`;
    const reg = await client.request("/auth/register", "POST", {
      name: "Typo User",
      email,
      password: "SuperSecretPassword123!",
      workspaceName: "Typo Workspace"
    });
    assert.equal(reg.status, 201);

    const correctedEmail = `corrected.${process.pid}@example.test`;
    const changeRes = await client.request("/auth/change-email", "POST", { newEmail: correctedEmail });
    assert.equal(changeRes.status, 200);
    assert.equal(changeRes.body.email, correctedEmail);

    const userRes = await testPool.query("SELECT email, email_verified FROM users WHERE id = $1", [reg.body.user.id]);
    assert.equal(userRes.rows[0].email, correctedEmail);
    assert.equal(userRes.rows[0].email_verified, false);

    await testPool.query("UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1", [reg.body.user.id]);
    const blockedChange = await client.request("/auth/change-email", "POST", { newEmail: "another@example.test" });
    assert.equal(blockedChange.status, 400);
    assert.match(blockedChange.body.error, /already verified/i);
  });

  test("Google OAuth configuration URL helper behaves securely", async () => {
    const client = new ApiClient(baseUrl);

    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const unconfigRes = await client.request("/auth/google/url");
    assert.equal(unconfigRes.status, 200);
    assert.equal(unconfigRes.body.configured, false);

    process.env.GOOGLE_CLIENT_ID = "mock-google-client-id.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";

    const configRes = await client.request("/auth/google/url");
    assert.equal(configRes.status, 200);
    assert.equal(configRes.body.configured, true);
    assert.ok(typeof configRes.body.url === "string");

    const authUrl = getGoogleAuthorizationUrl({
      redirectUri: "http://localhost:3000/auth/callback/google",
      state: "random-state-12345",
      codeChallenge: "mock-code-challenge"
    });
    const parsed = new URL(authUrl);
    assert.equal(parsed.hostname, "accounts.google.com");
    assert.equal(parsed.pathname, "/o/oauth2/v2/auth");
    assert.equal(parsed.searchParams.get("client_id"), "mock-google-client-id.apps.googleusercontent.com");
    assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:3000/auth/callback/google");
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("state"), "random-state-12345");
    assert.equal(parsed.searchParams.get("code_challenge"), "mock-code-challenge");
    assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  });

  test("Google token verification rejects invalid tokens, unverified emails, and accepts valid payloads", async () => {
    process.env.GOOGLE_CLIENT_ID = "mock-google-client-id.apps.googleusercontent.com";

    // 1. Rejection on non-200 from Google endpoint
    const mockFailFetcher = async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 });
    await assert.rejects(
      async () => verifyGoogleIdToken("bad-token", mockFailFetcher as any),
      /Google ID token validation failed/i
    );

    // 2. Rejection on audience mismatch
    const mockMismatchedAudFetcher = async () =>
      new Response(
        JSON.stringify({
          aud: "wrong-client-id",
          iss: "https://accounts.google.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "test@example.com",
          email_verified: "true",
          sub: "google-1"
        }),
        { status: 200 }
      );
    await assert.rejects(
      async () => verifyGoogleIdToken("some-token", mockMismatchedAudFetcher as any),
      /audience does not match/i
    );

    // 3. Rejection when email is not verified by Google
    const mockUnverifiedEmailFetcher = async () =>
      new Response(
        JSON.stringify({
          aud: "mock-google-client-id.apps.googleusercontent.com",
          iss: "https://accounts.google.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "unverified@example.com",
          email_verified: false,
          sub: "google-2"
        }),
        { status: 200 }
      );
    await assert.rejects(
      async () => verifyGoogleIdToken("some-token", mockUnverifiedEmailFetcher as any),
      /not verified by Google/i
    );

    // 4. Success on valid token
    const mockValidFetcher = async () =>
      new Response(
        JSON.stringify({
          aud: "mock-google-client-id.apps.googleusercontent.com",
          iss: "https://accounts.google.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "verified-user@example.com",
          email_verified: "true",
          name: "Verified Google User",
          sub: "google-verified-123"
        }),
        { status: 200 }
      );
    const profile = await verifyGoogleIdToken("valid-token", mockValidFetcher as any);
    assert.equal(profile.email, "verified-user@example.com");
    assert.equal(profile.emailVerified, true);
    assert.equal(profile.name, "Verified Google User");
    assert.equal(profile.googleId, "google-verified-123");
  });
});
