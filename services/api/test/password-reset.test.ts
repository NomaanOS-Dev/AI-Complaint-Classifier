import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import dotenv from "dotenv";
import pg from "pg";
import type { VerificationEmailClient } from "../src/email-service.js";

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
const schema = `nomaanos_pwreset_${process.pid}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
let testPool: InstanceType<typeof Pool>;
let server: Server;
let rateLimitServer: Server | undefined;
let baseUrl: string;
let createdSchema = false;

interface SentEmailRecord {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

let sentEmails: SentEmailRecord[] = [];
let mockResendMode: "succeed" | "reject" = "succeed";

function sentResetEmails(): SentEmailRecord[] {
  return sentEmails.filter((email) => email.subject.includes("Reset your password"));
}

const mockResendClient: VerificationEmailClient = {
  emails: {
    send: async (payload) => {
      sentEmails.push(payload);
      if (mockResendMode === "reject") {
        return {
          data: null,
          error: {
            name: "validation_error",
            statusCode: 403,
            message: "Simulated Resend rejection"
          }
        };
      }
      return { data: { id: `re_test_${sentEmails.length}` }, error: null };
    }
  }
};

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

function extractTokenFromEmail(email: SentEmailRecord): string {
  const match = email.text.match(/\/reset-password\?token=([a-f0-9]+)/i);
  assert.ok(match, "Reset email must include /reset-password?token=... link");
  return match[1];
}

describe("Forgot password and reset password flows", () => {
  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must be defined");
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;

    const testUrl = new URL(process.env.DATABASE_URL!);
    testUrl.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = testUrl.toString();
    process.env.WEB_ORIGIN = "https://app.nomaanos.test";

    const { migrate, pool } = await import("../src/db.js");
    testPool = pool;
    await migrate();

    const { createApp } = await import("../src/app.js");
    server = createHttpServer(createApp({ emailResendClient: mockResendClient }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (rateLimitServer) {
      await new Promise<void>((resolve, reject) => rateLimitServer!.close((err) => (err ? reject(err) : resolve())));
    }
    if (testPool) await testPool.end();
    if (createdSchema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  });

  test("registered vs unregistered emails return identical generic response and store only hashed 30-min tokens", async () => {
    sentEmails = [];
    mockResendMode = "succeed";

    const regClient = new ApiClient(baseUrl);
    const email = `reset-user.${process.pid}@example.test`;
    const reg = await regClient.request("/auth/register", "POST", {
      name: "Reset User",
      email,
      password: "InitialPassword123!",
      workspaceName: "Reset Workspace"
    });
    assert.equal(reg.status, 201);
    await testPool.query("UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1", [reg.body.user.id]);

    const guestClient = new ApiClient(baseUrl);
    const unregisteredRes = await guestClient.request("/auth/forgot-password", "POST", {
      email: `nobody.${process.pid}@example.test`
    });
    assert.equal(unregisteredRes.status, 200);
    assert.equal(sentResetEmails().length, 0);

    const registeredRes = await guestClient.request("/auth/forgot-password", "POST", { email });
    assert.equal(registeredRes.status, 200);
    assert.equal(registeredRes.body.message, unregisteredRes.body.message);
    assert.equal(sentResetEmails().length, 1);
    assert.equal(sentResetEmails()[0].to, email);
    assert.match(sentResetEmails()[0].html, /https:\/\/app\.nomaanos\.test\/reset-password\?token=/);
    assert.match(sentResetEmails()[0].html, /30 minutes/i);

    const rawToken1 = extractTokenFromEmail(sentResetEmails()[0]);
    const hash1 = createHash("sha256").update(rawToken1).digest("hex");
    const tokenRows = await testPool.query<{
      token_hash: string;
      expires_at: Date;
      created_at: Date;
      used_at: Date | null;
    }>("SELECT token_hash, expires_at, created_at, used_at FROM password_reset_tokens WHERE user_id = $1", [
      reg.body.user.id
    ]);
    assert.equal(tokenRows.rowCount, 1);
    assert.equal(tokenRows.rows[0].token_hash, hash1);
    assert.notEqual(tokenRows.rows[0].token_hash, rawToken1);
    assert.equal(tokenRows.rows[0].used_at, null);
    const ttlMs = new Date(tokenRows.rows[0].expires_at).getTime() - new Date(tokenRows.rows[0].created_at).getTime();
    assert.ok(ttlMs >= 29 * 60 * 1000 && ttlMs <= 31 * 60 * 1000, `Expected ~30m expiry, got ${ttlMs}`);

    // Requesting a second reset invalidates the previous outstanding token
    const secondRes = await guestClient.request("/auth/forgot-password", "POST", { email });
    assert.equal(secondRes.status, 200);
    assert.equal(sentResetEmails().length, 2);
    const rawToken2 = extractTokenFromEmail(sentResetEmails()[1]);
    assert.notEqual(rawToken2, rawToken1);

    const firstRowAfter = await testPool.query<{ used_at: Date | null }>(
      "SELECT used_at FROM password_reset_tokens WHERE token_hash = $1",
      [hash1]
    );
    assert.ok(firstRowAfter.rows[0].used_at instanceof Date);

    // The invalidated first token must be rejected
    const useOldToken = await guestClient.request("/auth/reset-password", "POST", {
      token: rawToken1,
      password: "UpdatedPassword123!",
      confirmPassword: "UpdatedPassword123!"
    });
    assert.equal(useOldToken.status, 400);
  });

  test("Resend rejection still returns generic response, logs error, and does not verify or update user", async () => {
    sentEmails = [];
    mockResendMode = "reject";
    const errors: string[] = [];
    const infos: string[] = [];
    const origError = console.error;
    const origInfo = console.info;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    console.info = (...args: unknown[]) => infos.push(args.map(String).join(" "));

    try {
      const regClient = new ApiClient(baseUrl);
      const email = `resend-fail.${process.pid}@example.test`;
      const reg = await regClient.request("/auth/register", "POST", {
        name: "Reject User",
        email,
        password: "InitialPassword123!",
        workspaceName: "Reject Workspace"
      });
      assert.equal(reg.status, 201);

      const guestClient = new ApiClient(baseUrl);
      const res = await guestClient.request("/auth/forgot-password", "POST", { email });
      assert.equal(res.status, 200);
      assert.equal(sentResetEmails().length, 1);

      assert.ok(errors.some((line) => line.includes("Simulated Resend rejection")));
      assert.ok(!infos.some((line) => /Password reset email dispatched/i.test(line)));

      const userRow = await testPool.query<{ email_verified: boolean }>(
        "SELECT email_verified FROM users WHERE id = $1",
        [reg.body.user.id]
      );
      assert.equal(userRow.rows[0].email_verified, false);
    } finally {
      console.error = origError;
      console.info = origInfo;
      mockResendMode = "succeed";
    }
  });

  test("resets password once, rejects invalid/expired/used/mismatched inputs, invalidates sessions, and swaps valid password", async () => {
    sentEmails = [];
    mockResendMode = "succeed";

    const activeSessionClient = new ApiClient(baseUrl);
    const email = `full-reset.${process.pid}@example.test`;
    const oldPassword = "OldStrongPassword123!";
    const newPassword = "NewStrongPassword456!";

    const reg = await activeSessionClient.request("/auth/register", "POST", {
      name: "Full Reset User",
      email,
      password: oldPassword,
      workspaceName: "Full Reset Workspace"
    });
    assert.equal(reg.status, 201);
    const userId = reg.body.user.id;
    await testPool.query("UPDATE users SET email_verified = true, email_verified_at = now() WHERE id = $1", [userId]);

    // Confirm active session currently works
    assert.equal((await activeSessionClient.request("/auth/me")).status, 200);

    const resetClient = new ApiClient(baseUrl);
    const forgotRes = await resetClient.request("/auth/forgot-password", "POST", { email });
    assert.equal(forgotRes.status, 200);
    const rawToken = extractTokenFromEmail(sentResetEmails()[0]);

    // Invalid token rejected
    const invalidRes = await resetClient.request("/auth/reset-password", "POST", {
      token: "0".repeat(64),
      password: newPassword,
      confirmPassword: newPassword
    });
    assert.equal(invalidRes.status, 400);
    assert.match(invalidRes.body.error, /invalid/i);

    // Password mismatch rejected without consuming token
    const mismatchRes = await resetClient.request("/auth/reset-password", "POST", {
      token: rawToken,
      password: newPassword,
      confirmPassword: "DifferentPassword789!"
    });
    assert.equal(mismatchRes.status, 400);
    assert.match(mismatchRes.body.error, /do not match/i);

    // Valid token updates password
    const successRes = await resetClient.request("/auth/reset-password", "POST", {
      token: rawToken,
      password: newPassword,
      confirmPassword: newPassword
    });
    assert.equal(successRes.status, 200);
    assert.equal(successRes.body.success, true);

    // Reusing the same token fails
    const reuseRes = await resetClient.request("/auth/reset-password", "POST", {
      token: rawToken,
      password: "AnotherPassword789!",
      confirmPassword: "AnotherPassword789!"
    });
    assert.equal(reuseRes.status, 400);
    assert.match(reuseRes.body.error, /already been used/i);

    // Existing session was invalidated
    assert.equal((await activeSessionClient.request("/auth/me")).status, 401);

    // Old password no longer works
    const loginClient = new ApiClient(baseUrl);
    const oldLogin = await loginClient.request("/auth/login", "POST", { email, password: oldPassword });
    assert.equal(oldLogin.status, 401);

    // New password works
    const newLogin = await loginClient.request("/auth/login", "POST", { email, password: newPassword });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.user.email, email);

    // Expired token rejected
    const expiredRawToken = randomBytes(32).toString("hex");
    const expiredHash = createHash("sha256").update(expiredRawToken).digest("hex");
    await testPool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')",
      [userId, expiredHash]
    );
    const expiredRes = await resetClient.request("/auth/reset-password", "POST", {
      token: expiredRawToken,
      password: "AfterExpiredPassword123!",
      confirmPassword: "AfterExpiredPassword123!"
    });
    assert.equal(expiredRes.status, 400);
    assert.match(expiredRes.body.error, /expired/i);
  });

  test("Google-only accounts cannot trigger reset emails or set a local password", async () => {
    sentEmails = [];
    mockResendMode = "succeed";

    const { createApp } = await import("../src/app.js");
    const googleServer = createHttpServer(createApp({ emailResendClient: mockResendClient }));
    googleServer.listen(0, "127.0.0.1");
    await once(googleServer, "listening");
    const addr = googleServer.address();
    assert.ok(addr && typeof addr !== "string");
    const googleBaseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const googleEmail = `google-only.${process.pid}@example.test`;
      const insertRes = await testPool.query<{ id: string }>(
        `INSERT INTO users (name, email, google_id, password_hash, email_verified, email_verified_at)
         VALUES ($1, $2, $3, NULL, true, now())
         RETURNING id`,
        ["Google User", googleEmail, `google-sub-${process.pid}`]
      );
      const googleUserId = insertRes.rows[0].id;

      const guestClient = new ApiClient(googleBaseUrl);
      const forgotRes = await guestClient.request("/auth/forgot-password", "POST", { email: googleEmail });
      assert.equal(forgotRes.status, 200);
      assert.equal(sentEmails.length, 0);

      const tokenRows = await testPool.query("SELECT id FROM password_reset_tokens WHERE user_id = $1", [googleUserId]);
      assert.equal(tokenRows.rowCount, 0);

      // Defense in depth: even if a token existed for a Google-only account, reset-password rejects setting a local password
      const syntheticToken = randomBytes(32).toString("hex");
      const syntheticHash = createHash("sha256").update(syntheticToken).digest("hex");
      await testPool.query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
        [googleUserId, syntheticHash]
      );
      const resetRes = await guestClient.request("/auth/reset-password", "POST", {
        token: syntheticToken,
        password: "UnauthorizedLocalPass123!",
        confirmPassword: "UnauthorizedLocalPass123!"
      });
      assert.equal(resetRes.status, 400);
      assert.match(resetRes.body.error, /Google/i);

      const userAfter = await testPool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [googleUserId]
      );
      assert.equal(userAfter.rows[0].password_hash, null);
    } finally {
      await new Promise<void>((resolve, reject) => googleServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("forgot-password and reset-password enforce rate limiting", async () => {
    const { createApp } = await import("../src/app.js");
    rateLimitServer = createHttpServer(createApp({ emailResendClient: mockResendClient }));
    rateLimitServer.listen(0, "127.0.0.1");
    await once(rateLimitServer, "listening");
    const address = rateLimitServer.address();
    assert.ok(address && typeof address !== "string");
    const rlClient = new ApiClient(`http://127.0.0.1:${address.port}`);

    for (let i = 0; i < 5; i++) {
      const res = await rlClient.request("/auth/forgot-password", "POST", {
        email: `rl.${i}@example.test`
      });
      assert.equal(res.status, 200);
    }
    const forgotBlocked = await rlClient.request("/auth/forgot-password", "POST", {
      email: "rl.blocked@example.test"
    });
    assert.equal(forgotBlocked.status, 429);
    assert.ok(Number(forgotBlocked.headers.get("retry-after")) > 0);

    for (let i = 0; i < 10; i++) {
      const res = await rlClient.request("/auth/reset-password", "POST", {
        token: `${i}`.padEnd(32, "a"),
        password: "ValidLengthPassword123!",
        confirmPassword: "ValidLengthPassword123!"
      });
      assert.equal(res.status, 400);
    }
    const resetBlocked = await rlClient.request("/auth/reset-password", "POST", {
      token: "z".repeat(32),
      password: "ValidLengthPassword123!",
      confirmPassword: "ValidLengthPassword123!"
    });
    assert.equal(resetBlocked.status, 429);
    assert.ok(Number(resetBlocked.headers.get("retry-after")) > 0);
  });
});
