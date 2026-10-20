import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env"), quiet: true });
process.env.SESSION_SECRET ??= randomBytes(48).toString("base64");

if (!existsSync("/.dockerenv") && process.env.DATABASE_URL) {
  const localTestUrl = new URL(process.env.DATABASE_URL);
  if (localTestUrl.hostname === "db") {
    localTestUrl.hostname = "127.0.0.1";
    localTestUrl.port = process.env.POSTGRES_PORT ?? "5433";
    process.env.DATABASE_URL = localTestUrl.toString();
  }
}

const { Pool } = pg;
const schema = `nomaanos_test_${process.pid}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
let testPool: InstanceType<typeof Pool>;
let server: ReturnType<import("express").Express["listen"]>;
let baseUrl: string;
let createdSchema = false;

type ApiResult = { status: number; body: Record<string, any> };

class ApiClient {
  cookie = "";
  csrfToken = "";

  private remember(response: Response) {
    const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";", 1)[0];
  }

  async request(pathname: string, method = "GET", body?: unknown, csrf = ["POST", "PATCH", "DELETE"].includes(method)) {
    if (csrf && !this.csrfToken) {
      const tokenResponse = await fetch(`${baseUrl}/auth/csrf`, { headers: this.cookie ? { cookie: this.cookie } : {} });
      this.remember(tokenResponse);
      this.csrfToken = (await tokenResponse.json() as { csrfToken: string }).csrfToken;
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf) headers["x-csrf-token"] = this.csrfToken;
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    this.remember(response);
    const responseBody = response.status === 204 ? {} : await response.json() as Record<string, any>;
    if (typeof responseBody.csrfToken === "string") this.csrfToken = responseBody.csrfToken;
    return { status: response.status, body: responseBody } satisfies ApiResult;
  }
}

async function register(client: ApiClient, email: string, name = "Test User", workspaceName = "Test Workspace") {
  return client.request("/auth/register", "POST", {
    name,
    email,
    password: "A-safe-test-password-123",
    workspaceName
  });
}

describe("Day 2 authentication and tenant isolation", () => {
  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to the development database for isolated-schema tests");
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    const testUrl = new URL(process.env.DATABASE_URL!);
    testUrl.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = testUrl.toString();
    testPool = new Pool({ connectionString: process.env.DATABASE_URL });
    process.env.SESSION_SECRET = randomBytes(48).toString("base64");
    const { migrate, pool } = await import("../src/db.js");
    testPool = pool;
    await migrate();
    const { createApp } = await import("../src/app.js");
    server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (testPool) await testPool.end();
    if (createdSchema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  });

  test("registration creates a normalized user, workspace, and owner membership; login succeeds", async () => {
    const email = ` Alice.${process.pid}@Example.Test `;
    const client = new ApiClient();
    const registration = await register(client, email);
    assert.equal(registration.status, 201);
    assert.equal(registration.body.user.email, email.trim().toLowerCase());
    assert.equal(registration.body.workspace.role, "owner");
    const me = await client.request("/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, registration.body.user.id);

    const freshClient = new ApiClient();
    const invalid = await freshClient.request("/auth/login", "POST", { email, password: "wrong-password" });
    assert.equal(invalid.status, 401);
    const unknownClient = new ApiClient();
    const unknown = await unknownClient.request("/auth/login", "POST", { email: `unknown.${process.pid}@example.test`, password: "wrong-password" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, invalid.body.error);
    const valid = await freshClient.request("/auth/login", "POST", { email, password: "A-safe-test-password-123" });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.user.email, email.trim().toLowerCase());
  });

  test("duplicate normalized email registration is rejected", async () => {
    const first = new ApiClient();
    const email = `duplicate.${process.pid}@example.test`;
    assert.equal((await register(first, email)).status, 201);
    const second = new ApiClient();
    const duplicate = await register(second, ` ${email.toUpperCase()} `);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "Unable to register with those details.");
  });

  test("protected workspace listing rejects unauthenticated requests", async () => {
    const anonymous = new ApiClient();
    assert.equal((await anonymous.request("/workspaces")).status, 401);
  });

  test("authenticated users can create and list their workspaces", async () => {
    const client = new ApiClient();
    const registration = await register(client, `workspace.${process.pid}@example.test`);
    const created = await client.request("/workspaces", "POST", { name: "Second workspace" });
    assert.equal(created.status, 201);
    assert.equal(created.body.workspace.role, "owner");
    const listing = await client.request("/workspaces");
    assert.equal(listing.status, 200);
    assert.equal(listing.body.workspaces.length, 2);
    assert.ok(listing.body.workspaces.some((workspace: { id: string }) => workspace.id === registration.body.workspace.id));
  });

  test("workspace reads are membership-scoped and updates enforce roles", async () => {
    const owner = new ApiClient();
    const ownerSignup = await register(owner, `owner.${process.pid}@example.test`, "Owner", "Owner workspace");
    const member = new ApiClient();
    const memberSignup = await register(member, `member.${process.pid}@example.test`, "Member", "Member workspace");
    const ownerWorkspaceId = ownerSignup.body.workspace.id as string;
    const memberWorkspaceId = memberSignup.body.workspace.id as string;

    assert.equal((await owner.request(`/workspaces/${memberWorkspaceId}`)).status, 404);
    assert.equal((await member.request(`/workspaces/${ownerWorkspaceId}`)).status, 404);
    await testPool.query(
      "INSERT INTO tenant_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [ownerWorkspaceId, memberSignup.body.user.id]
    );
    const authorizedRead = await member.request(`/workspaces/${ownerWorkspaceId}`);
    assert.equal(authorizedRead.status, 200);
    assert.equal(authorizedRead.body.workspace.role, "member");
    const forbiddenUpdate = await member.request(`/workspaces/${ownerWorkspaceId}`, "PATCH", { name: "Unauthorized change" });
    assert.equal(forbiddenUpdate.status, 403);
    const ownerUpdate = await owner.request(`/workspaces/${ownerWorkspaceId}`, "PATCH", { name: "Updated workspace" });
    assert.equal(ownerUpdate.status, 200);
    assert.equal(ownerUpdate.body.workspace.name, "Updated workspace");
  });

  test("state-changing routes reject missing CSRF tokens", async () => {
    const client = new ApiClient();
    await client.request("/auth/csrf", "GET", undefined, false);
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { cookie: client.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "No CSRF", email: "nocsrf@example.test", password: "A-safe-test-password-123", workspaceName: "No CSRF" })
    });
    assert.equal(response.status, 403);
  });

  test("logout invalidates the session; API health and migrations remain available", async () => {
    const client = new ApiClient();
    await register(client, `logout.${process.pid}@example.test`);
    assert.equal((await client.request("/auth/logout", "POST", {})).status, 204);
    assert.equal((await client.request("/auth/me")).status, 401);
    const health = await client.request("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok", service: "api", database: "ok" });
    const migrations = await testPool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(migrations.rows.map((row: { name: string }) => row.name), ["001-foundation.sql", "002-auth.sql"]);
  });
});
