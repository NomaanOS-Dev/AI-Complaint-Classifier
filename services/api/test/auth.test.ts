import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import dotenv from "dotenv";
import pg from "pg";
import type { ResendReceivedEmail } from "../src/resend-receiving.js";

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
const originalIntegrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;
const originalResendApiKey = process.env.RESEND_API_KEY;
const originalResendWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;
const originalResendInboundDomain = process.env.RESEND_INBOUND_DOMAIN;
const originalMetaAppSecret = process.env.META_APP_SECRET;
const originalMetaVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
const originalPublicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;
const originalMetaAppId = process.env.META_APP_ID;
const originalMetaLoginConfigId = process.env.META_LOGIN_CONFIG_ID;
const originalMetaGraphVersion = process.env.META_GRAPH_API_VERSION;
const originalMetaTokenEncryptionKey = process.env.META_TOKEN_ENCRYPTION_KEY;
const originalWebOrigin = process.env.WEB_ORIGIN;
const schema = `nomaanos_test_${process.pid}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
let testPool: InstanceType<typeof Pool>;
let server: Server;
let rateLimitServer: Server | undefined;
let complaintsServer: Server | undefined;
let analysisServer: Server | undefined;
let analyticsServer: Server | undefined;
let integrationServer: Server | undefined;
let webhookTestServer: Server | undefined;
let whatsappTestServer: Server | undefined;
let mockAiServer: Server | undefined;
let baseUrl: string;
let createdSchema = false;

type ApiResult = { status: number; body: Record<string, any>; headers: Headers };
let metaParser: (payload: unknown) => unknown[];
let metaSignatureVerifier: (rawBody: Buffer, supplied: string | undefined, appSecret: string) => boolean;
let sharedMetaOwner: ApiClient | undefined;
let sharedMetaWorkspaceId: string | undefined;

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
      this.csrfToken = (await tokenResponse.json() as { csrfToken: string }).csrfToken;
    }
    const headers: Record<string, string> = {};
    headers.origin = "http://localhost:3000";
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf) headers["x-csrf-token"] = this.csrfToken;
    const response = await fetch(`${this.origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    this.remember(response);
    const responseBody = response.status === 204 ? {} : await response.json() as Record<string, any>;
    if (typeof responseBody.csrfToken === "string") this.csrfToken = responseBody.csrfToken;
    return { status: response.status, body: responseBody, headers: response.headers } satisfies ApiResult;
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

describe("authentication, tenant isolation, and complaints", () => {
  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to the development database for isolated-schema tests");
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    const testUrl = new URL(process.env.DATABASE_URL!);
    testUrl.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = testUrl.toString();
    testPool = new Pool({ connectionString: process.env.DATABASE_URL });
    process.env.SESSION_SECRET = randomBytes(48).toString("base64");
    const { parseMetaMessages, verifyMetaSignature } = await import("../src/meta-social.js");
    metaParser = parseMetaMessages;
    metaSignatureVerifier = verifyMetaSignature;
    const { migrate, pool } = await import("../src/db.js");
    testPool = pool;
    const selectedSchema = await testPool.query<{ schema: string }>("SELECT current_schema() AS schema");
    assert.equal(selectedSchema.rows[0].schema, schema, "API pool must use the isolated test schema");
    await migrate();
    const { createApp } = await import("../src/app.js");
    server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (rateLimitServer) await new Promise<void>((resolve, reject) => rateLimitServer!.close((error) => error ? reject(error) : resolve()));
    if (complaintsServer) await new Promise<void>((resolve, reject) => complaintsServer!.close((error) => error ? reject(error) : resolve()));
    if (analysisServer) await new Promise<void>((resolve, reject) => analysisServer!.close((error) => error ? reject(error) : resolve()));
    if (analyticsServer) await new Promise<void>((resolve, reject) => analyticsServer!.close((error) => error ? reject(error) : resolve()));
    if (integrationServer) await new Promise<void>((resolve, reject) => integrationServer!.close((error) => error ? reject(error) : resolve()));
    if (webhookTestServer) await new Promise<void>((resolve, reject) => webhookTestServer!.close((error) => error ? reject(error) : resolve()));
    if (whatsappTestServer) await new Promise<void>((resolve, reject) => whatsappTestServer!.close((error) => error ? reject(error) : resolve()));
    if (mockAiServer) await new Promise<void>((resolve, reject) => mockAiServer!.close((error) => error ? reject(error) : resolve()));
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (testPool) await testPool.end();
    if (createdSchema) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    if (originalIntegrationEncryptionKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY; else process.env.INTEGRATION_ENCRYPTION_KEY = originalIntegrationEncryptionKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalResendApiKey;
    if (originalResendWebhookSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = originalResendWebhookSecret;
    if (originalResendInboundDomain === undefined) delete process.env.RESEND_INBOUND_DOMAIN; else process.env.RESEND_INBOUND_DOMAIN = originalResendInboundDomain;
    if (originalMetaAppSecret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = originalMetaAppSecret;
    if (originalMetaVerifyToken === undefined) delete process.env.META_WEBHOOK_VERIFY_TOKEN; else process.env.META_WEBHOOK_VERIFY_TOKEN = originalMetaVerifyToken;
    if (originalPublicApiBaseUrl === undefined) delete process.env.PUBLIC_API_BASE_URL; else process.env.PUBLIC_API_BASE_URL = originalPublicApiBaseUrl;
    if (originalMetaAppId === undefined) delete process.env.META_APP_ID; else process.env.META_APP_ID = originalMetaAppId;
    if (originalMetaLoginConfigId === undefined) delete process.env.META_LOGIN_CONFIG_ID; else process.env.META_LOGIN_CONFIG_ID = originalMetaLoginConfigId;
    if (originalMetaGraphVersion === undefined) delete process.env.META_GRAPH_API_VERSION; else process.env.META_GRAPH_API_VERSION = originalMetaGraphVersion;
    if (originalMetaTokenEncryptionKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY; else process.env.META_TOKEN_ENCRYPTION_KEY = originalMetaTokenEncryptionKey;
    if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN; else process.env.WEB_ORIGIN = originalWebOrigin;
  });

  test("registration creates a normalized user, workspace, and owner membership; login succeeds", async () => {
    const email = ` Alice.${process.pid}@Example.Test `;
    const client = new ApiClient();
    const registration = await register(client, email);
    sharedMetaOwner = client;
    sharedMetaWorkspaceId = registration.body.workspace.id as string;
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
    assert.deepEqual(migrations.rows.map((row: { name: string }) => row.name), ["001-foundation.sql", "002-auth.sql", "003-complaints.sql", "004-complaint-analysis.sql", "005-complaint-activity.sql", "006-integrations.sql", "007-contact-email-ingestion.sql", "008-embed-contact-forms.sql", "009-meta-social-inbox.sql", "010-whatsapp-embedded-signup.sql"]);
  });

  test("counts successful and failed auth attempts and returns a retry window", async () => {
    const { createApp } = await import("../src/app.js");
    rateLimitServer = createApp().listen(0, "127.0.0.1");
    await once(rateLimitServer, "listening");
    const address = rateLimitServer.address();
    assert.ok(address && typeof address !== "string");
    const client = new ApiClient(`http://127.0.0.1:${address.port}`);
    const email = `ratelimit.${process.pid}@example.test`;
    assert.equal((await client.request("/auth/login", "POST", { email, password: "wrong-password" })).status, 401);
    assert.equal((await register(client, email)).status, 201);
    for (let attempt = 0; attempt < 8; attempt++) {
      assert.equal((await client.request("/auth/login", "POST", { email, password: "A-safe-test-password-123" })).status, 200);
    }
    const limited = await client.request("/auth/login", "POST", { email, password: "A-safe-test-password-123" });
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `expected a positive retry time under 15 minutes; got ${retryAfter}`);
    assert.match(limited.headers.get("access-control-expose-headers") ?? "", /Retry-After/i);
  });

  test("complaints are validated, paginated, searchable, and isolated by workspace and role", async () => {
    const { createApp } = await import("../src/app.js");
    complaintsServer = createApp().listen(0, "127.0.0.1");
    await once(complaintsServer, "listening");
    const address = complaintsServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = new ApiClient(origin);
    const ownerSignup = await register(owner, `complaints.owner.${process.pid}@example.test`);
    const workspaceId = ownerSignup.body.workspace.id as string;
    const member = new ApiClient(origin);
    const memberSignup = await register(member, `complaints.member.${process.pid}@example.test`);
    const memberWorkspaceId = memberSignup.body.workspace.id as string;
    await testPool.query("INSERT INTO tenant_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [workspaceId, memberSignup.body.user.id]);

    assert.equal((await owner.request("/workspaces/not-a-uuid/complaints", "POST", { title: "Bad workspace", description: "Invalid id" })).status, 404);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "No CSRF", description: "Token missing" }, false)).status, 403);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "  ", description: "Missing title" })).status, 400);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Bad email", description: "Description", customer_email: "not-an-email" })).status, 400);
    const createdA = await member.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Damaged parcel", description: "The item arrived damaged.", customer_email: "Customer@Example.test" });
    const createdB = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Late delivery", description: "The package is late." });
    const other = await member.request(`/workspaces/${memberWorkspaceId}/complaints`, "POST", { title: "Private complaint", description: "Separate workspace." });
    assert.equal(createdA.status, 201);
    assert.equal(createdA.body.complaint.customer_email, "customer@example.test");
    assert.equal(createdA.body.complaint.status, "open");
    assert.equal(createdB.status, 201);
    assert.equal(other.status, 201);
    const complaintId = createdA.body.complaint.id as string;
    const activityPath = `/workspaces/${workspaceId}/complaints/${complaintId}/activity`;
    const createdActivity = await member.request(activityPath);
    assert.equal(createdActivity.status, 200);
    assert.equal(createdActivity.body.events.length, 1);
    assert.equal(createdActivity.body.events[0].event_type, "complaint_created");
    assert.equal(createdActivity.body.events[0].actor_user_id, memberSignup.body.user.id);
    assert.equal(createdActivity.body.events[0].actor_name, "Test User");
    assert.ok(Number.isFinite(Date.parse(createdActivity.body.events[0].occurred_at)));
    await assert.rejects(
      testPool.query("UPDATE complaint_activity_events SET metadata = '{}'::jsonb WHERE id = $1", [createdActivity.body.events[0].id]),
      /append-only/
    );
    const anonymousTimeline = await new ApiClient(origin).request(activityPath);
    assert.equal(anonymousTimeline.status, 401);
    assert.equal((await owner.request(`/workspaces/${memberWorkspaceId}/complaints/${complaintId}/activity`)).status, 404);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints/${other.body.complaint.id}/activity`)).status, 404);
    assert.equal((await member.request(`${activityPath}?limit=51`)).status, 400);
    assert.equal((await member.request(`${activityPath}?cursor=not-a-uuid`)).status, 400);

    const list = await member.request(`/workspaces/${workspaceId}/complaints?limit=1&offset=0`);
    assert.equal(list.status, 200);
    assert.equal(list.body.complaints.length, 1);
    assert.equal(list.body.pagination.hasMore, true);
    const workspaceOnly = await member.request(`/workspaces/${workspaceId}/complaints?limit=50`);
    assert.equal(workspaceOnly.body.complaints.length, 2);
    assert.ok(workspaceOnly.body.complaints.every((item: { workspace_id: string }) => item.workspace_id === workspaceId));
    assert.ok(workspaceOnly.body.complaints.every((item: { analysis_category: string | null }) => item.analysis_category === null));
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints?status=closed`)).body.complaints.length, 0);
    const filtered = await member.request(`/workspaces/${workspaceId}/complaints?status=open&q=damaged`);
    assert.equal(filtered.body.complaints.length, 1);
    assert.equal(filtered.body.complaints[0].id, complaintId);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints?limit=51`)).status, 400);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints?status=unknown`)).status, 400);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints/${complaintId}`)).body.complaint.id, complaintId);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints/not-a-uuid`)).status, 404);
    assert.equal((await member.request(`/workspaces/${memberWorkspaceId}/complaints/${complaintId}`)).status, 404);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${other.body.complaint.id}`)).status, 404);
    assert.equal((await member.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "resolved" })).status, 403);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "unknown" })).status, 400);
    const updated = await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "in_progress" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.complaint.status, "in_progress");
    const transitionEvents = (await owner.request(activityPath)).body.events;
    assert.equal(transitionEvents.length, 2);
    assert.equal(transitionEvents[1].event_type, "status_changed");
    assert.equal(transitionEvents[1].actor_user_id, ownerSignup.body.user.id);
    assert.deepEqual(transitionEvents[1].metadata, { previous_status: "open", new_status: "in_progress" });
    assert.ok(Date.parse(transitionEvents[1].occurred_at) >= Date.parse(transitionEvents[0].occurred_at));
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "open" }, false)).status, 403);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "unknown" })).status, 400);
    assert.equal((await owner.request(activityPath)).body.events.length, 2);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "in_progress" })).status, 200);
    assert.equal((await owner.request(activityPath)).body.events.length, 2);

    await testPool.query(`CREATE FUNCTION reject_status_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected activity failure'; END $$`);
    await testPool.query(`CREATE TRIGGER reject_status_activity BEFORE INSERT ON complaint_activity_events FOR EACH ROW WHEN (NEW.event_type = 'status_changed') EXECUTE FUNCTION reject_status_activity()`);
    const atomicFailure = await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "resolved" });
    await testPool.query("DROP TRIGGER reject_status_activity ON complaint_activity_events");
    await testPool.query("DROP FUNCTION reject_status_activity()");
    assert.equal(atomicFailure.status, 500);
    const afterRollback = await owner.request(`/workspaces/${workspaceId}/complaints/${complaintId}`);
    assert.equal(afterRollback.body.complaint.status, "in_progress");
    assert.equal((await owner.request(activityPath)).body.events.length, 2);

    const older = await testPool.query<{ id: string }>(
      `INSERT INTO complaints (workspace_id, title, description, created_by) VALUES ($1, 'Older complaint', 'Created before activity tracking.', $2) RETURNING id`,
      [workspaceId, ownerSignup.body.user.id]
    );
    const olderTimeline = await owner.request(`/workspaces/${workspaceId}/complaints/${older.rows[0].id}/activity`);
    assert.equal(olderTimeline.status, 200);
    assert.deepEqual(olderTimeline.body.events, []);

    const pagedComplaint = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Activity pagination", description: "Check ordered timeline pages." });
    const pagedComplaintId = pagedComplaint.body.complaint.id as string;
    const pagedPath = `/workspaces/${workspaceId}/complaints/${pagedComplaintId}/activity`;
    let pagedStatus = "open";
    for (let i = 0; i < 22; i++) {
      pagedStatus = pagedStatus === "open" ? "in_progress" : "open";
      assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${pagedComplaintId}/status`, "PATCH", { status: pagedStatus })).status, 200);
    }
    const firstPage = await owner.request(`${pagedPath}?limit=10`);
    assert.equal(firstPage.body.events.length, 10);
    assert.ok(firstPage.body.pagination.nextCursor);
    const secondPage = await owner.request(`${pagedPath}?limit=10&cursor=${firstPage.body.pagination.nextCursor}`);
    assert.equal(secondPage.body.events.length, 10);
    assert.notEqual(secondPage.body.events[0].id, firstPage.body.events[9].id);
    const firstLast = firstPage.body.events[9];
    const secondFirst = secondPage.body.events[0];
    assert.ok(Date.parse(secondFirst.occurred_at) > Date.parse(firstLast.occurred_at) ||
      (secondFirst.occurred_at === firstLast.occurred_at && secondFirst.id > firstLast.id));
    const finalPage = await owner.request(`${pagedPath}?limit=10&cursor=${secondPage.body.pagination.nextCursor}`);
    assert.equal(finalPage.body.events.length, 3);
    assert.equal(finalPage.body.pagination.nextCursor, null);
    assert.equal((await owner.request(`${pagedPath}?cursor=${createdActivity.body.events[0].id}`)).status, 400);
    assert.equal((await owner.request(`/workspaces/${memberWorkspaceId}/complaints/${complaintId}/status`, "PATCH", { status: "closed" })).status, 404);
    const anonymous = new ApiClient(origin);
    assert.equal((await anonymous.request(`/workspaces/${workspaceId}/complaints`)).status, 401);
    const migrations = await testPool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(migrations.rows.map((row: { name: string }) => row.name), ["001-foundation.sql", "002-auth.sql", "003-complaints.sql", "004-complaint-analysis.sql", "005-complaint-activity.sql", "006-integrations.sql", "007-contact-email-ingestion.sql", "008-embed-contact-forms.sql", "009-meta-social-inbox.sql", "010-whatsapp-embedded-signup.sql"]);
    const { migrate } = await import("../src/db.js");
    await migrate();
    const rerunMigrations = await testPool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(rerunMigrations.rows, migrations.rows);
  });

  test("complaint analysis is explicit, validated, persisted, repeatable, and workspace-scoped", async () => {
    let mode: "valid" | "malformed" | "unavailable" | "timeout" | "unconfigured" = "valid";
    let calls = 0;
    let payload: Record<string, unknown> = {
      category: "delivery", sentiment: "negative", severity: "medium", priority_score: 40, priority_label: "medium",
      reasoning_summary: "A delivery issue was identified by the deterministic test provider.",
      suggested_reply: "We are sorry about the delivery issue. Our team will review it.",
      model_name: "test-provider-v1", analyzed_at: new Date().toISOString()
    };
    mockAiServer = createHttpServer((_req, res) => {
      calls++;
      if (mode === "timeout") { setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end(JSON.stringify(payload)); } }, 500); return; }
      if (mode === "unavailable") { res.writeHead(503); res.end("{}"); return; }
      if (mode === "unconfigured") { res.setHeader("content-type", "application/json"); res.writeHead(503); res.end(JSON.stringify({ detail: "AI analysis is not configured on the server." })); return; }
      res.setHeader("content-type", "application/json"); res.writeHead(200);
      res.end(JSON.stringify(mode === "malformed" ? { ...payload, category: "made_up" } : payload));
    });
    mockAiServer.listen(0, "127.0.0.1");
    await once(mockAiServer, "listening");
    const mockAddress = mockAiServer.address();
    assert.ok(mockAddress && typeof mockAddress !== "string");
    const previousAiUrl = process.env.AI_SERVICE_URL;
    const previousTimeout = process.env.AI_SERVICE_TIMEOUT_MS;
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${mockAddress.port}`;
    process.env.AI_SERVICE_TIMEOUT_MS = "100";

    const { createApp } = await import("../src/app.js");
    analysisServer = createApp().listen(0, "127.0.0.1");
    await once(analysisServer, "listening");
    const analysisAddress = analysisServer.address();
    assert.ok(analysisAddress && typeof analysisAddress !== "string");
    const origin = `http://127.0.0.1:${analysisAddress.port}`;
    const owner = new ApiClient(origin);
    const signup = await register(owner, `analysis.owner.${process.pid}@example.test`);
    const workspaceId = signup.body.workspace.id as string;
    const created = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Late package", description: "The delivery is late." });
    assert.equal(created.status, 201);
    const complaintId = created.body.complaint.id as string;
    const analysisPath = `/workspaces/${workspaceId}/complaints/${complaintId}/analysis`;
    const analysisActivityPath = `/workspaces/${workspaceId}/complaints/${complaintId}/activity`;

    assert.equal((await owner.request(analysisPath)).body.analysis, null);
    assert.equal((await owner.request(analysisActivityPath)).body.events.length, 1);
    const anonymous = new ApiClient(origin);
    assert.equal((await anonymous.request(analysisPath)).status, 401);
    assert.equal((await owner.request(analysisPath, "POST", {}, false)).status, 403);
    mode = "malformed";
    assert.equal((await owner.request(analysisPath, "POST", {})).status, 502);
    assert.equal((await owner.request(analysisPath)).body.analysis, null);
    assert.equal((await owner.request(analysisActivityPath)).body.events.length, 1);
    mode = "unavailable";
    assert.equal((await owner.request(analysisPath, "POST", {})).status, 502);
    assert.equal((await owner.request(analysisActivityPath)).body.events.length, 1);
    mode = "timeout";
    const timeout = await owner.request(analysisPath, "POST", {});
    assert.equal(timeout.status, 504);
    assert.match(timeout.body.error, /timed out/i);
    assert.equal((await owner.request(analysisActivityPath)).body.events.length, 1);

    mode = "valid";
    const saved = await owner.request(analysisPath, "POST", {});
    assert.equal(saved.status, 200);
    assert.equal(saved.body.analysis.model_name, "test-provider-v1");
    const fetched = await owner.request(analysisPath);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.analysis.category, "delivery");
    const afterAnalysis = await owner.request(analysisActivityPath);
    assert.equal(afterAnalysis.body.events.length, 2);
    assert.equal(afterAnalysis.body.events[1].event_type, "analysis_completed");
    assert.equal(afterAnalysis.body.events[1].actor_user_id, signup.body.user.id);
      mode = "unconfigured";
      const missingProvider = await owner.request(analysisPath, "POST", {});
      assert.equal(missingProvider.status, 503);
      assert.match(missingProvider.body.error, /selected provider's API key/);
      assert.equal((await owner.request(analysisPath)).body.analysis.category, "delivery");
      assert.equal((await owner.request(analysisActivityPath)).body.events.length, 2);
    mode = "malformed";
    assert.equal((await owner.request(analysisPath, "POST", {})).status, 502);
    assert.equal((await owner.request(analysisPath)).body.analysis.category, "delivery");
    mode = "valid";
    payload = { ...payload, category: "refund", priority_score: 60, priority_label: "high", analyzed_at: new Date(Date.now() + 1000).toISOString() };
    const reanalysis = await owner.request(analysisPath, "POST", {});
    assert.equal(reanalysis.status, 200);
    assert.equal(reanalysis.body.analysis.category, "refund");
    const afterReanalysis = await owner.request(analysisActivityPath);
    assert.equal(afterReanalysis.body.events.length, 3);
    assert.equal(afterReanalysis.body.events[2].event_type, "analysis_completed");
    const count = await testPool.query("SELECT count(*)::int AS count FROM complaint_analyses WHERE complaint_id = $1", [complaintId]);
    assert.equal(count.rows[0].count, 1);
    const listed = await owner.request(`/workspaces/${workspaceId}/complaints?limit=50`);
    const listedComplaint = listed.body.complaints.find((item: { id: string }) => item.id === complaintId);
    assert.equal(listedComplaint.analysis_category, "refund");
    assert.equal(listedComplaint.analysis_priority_score, 60);

    const other = new ApiClient(origin);
    const otherSignup = await register(other, `analysis.other.${process.pid}@example.test`);
    const otherWorkspace = otherSignup.body.workspace.id as string;
    assert.equal((await owner.request(`/workspaces/${otherWorkspace}/complaints/${complaintId}/analysis`)).status, 404);
    assert.equal((await owner.request(`/workspaces/${otherWorkspace}/complaints/${complaintId}/analysis`, "POST", {})).status, 404);
    assert.ok(calls >= 5);
    if (previousAiUrl === undefined) delete process.env.AI_SERVICE_URL; else process.env.AI_SERVICE_URL = previousAiUrl;
    if (previousTimeout === undefined) delete process.env.AI_SERVICE_TIMEOUT_MS; else process.env.AI_SERVICE_TIMEOUT_MS = previousTimeout;
  });

  test("workspace analytics is date-filtered, workspace-scoped, and handles incomplete analysis history", async () => {
    const { createApp } = await import("../src/app.js");
    analyticsServer = createApp().listen(0, "127.0.0.1");
    await once(analyticsServer, "listening");
    const address = analyticsServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = new ApiClient(origin);
    const signup = await register(owner, `analytics.owner.${process.pid}@example.test`);
    const workspaceId = signup.body.workspace.id as string;
    const today = new Date().toISOString().slice(0, 10);
    const analyticsPath = `/workspaces/${workspaceId}/analytics/overview?startDate=${today}&endDate=${today}`;
    const create = async (title: string) => {
      const result = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title, description: `Details for ${title}.` });
      assert.equal(result.status, 201);
      return result.body.complaint as { id: string };
    };
    const resolved = await create("Resolved issue");
    const inProgress = await create("Open investigation");
    await create("Unanalyzed complaint");
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${resolved.id}/status`, "PATCH", { status: "resolved" })).status, 200);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/complaints/${inProgress.id}/status`, "PATCH", { status: "in_progress" })).status, 200);
    await testPool.query(
      `INSERT INTO complaint_analyses (complaint_id, category, sentiment, severity, priority_score, priority_label, reasoning_summary, suggested_reply, model_name, analyzed_at)
       VALUES ($1, 'payment', 'negative', 'critical', 90, 'urgent', 'Payment issue.', 'We will investigate.', 'test-model', now()),
              ($2, 'refund', 'neutral', 'medium', 40, 'medium', 'Refund request.', 'We will review.', 'test-model', now())`,
      [resolved.id, inProgress.id]
    );

    const overview = await owner.request(analyticsPath);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.totalComplaints, 3);
    assert.deepEqual(overview.body.statusCounts, { open: 1, in_progress: 1, resolved: 1, closed: 0 });
    assert.equal(overview.body.unresolvedCount, 2);
    assert.equal(overview.body.resolutionRate, 33.3);
    assert.equal(overview.body.resolutionTimeSampleSize, 1);
    assert.ok(overview.body.averageResolutionTimeHours >= 0);
    assert.deepEqual(overview.body.categories, [{ category: "payment", count: 1 }, { category: "refund", count: 1 }]);
    assert.deepEqual(overview.body.priorities, [{ label: "medium", count: 1 }, { label: "urgent", count: 1 }]);
    assert.deepEqual(overview.body.severities, [{ label: "critical", count: 1 }, { label: "medium", count: 1 }]);
    assert.deepEqual(overview.body.trends, [{ date: today, count: 3 }]);
    assert.equal(overview.body.dateRange.timezone, "UTC");
    assert.equal((await owner.request(`/workspaces/${workspaceId}/analytics/overview?startDate=2026-02-30&endDate=${today}`)).status, 400);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/analytics/overview?startDate=${today}&endDate=2026-01-01`)).status, 400);
    assert.equal((await owner.request("/workspaces/not-a-uuid/analytics/overview")).status, 404);
    const anonymous = new ApiClient(origin);
    assert.equal((await anonymous.request(`/workspaces/${workspaceId}/analytics/overview`)).status, 401);
    const outsiderSignup = await register(new ApiClient(origin), `analytics.outsider.${process.pid}@example.test`);
    assert.equal((await owner.request(`/workspaces/${outsiderSignup.body.workspace.id}/analytics/overview`)).status, 404);

    const emptyOwner = new ApiClient(origin);
    const emptySignup = await register(emptyOwner, `analytics.empty.${process.pid}@example.test`);
    const emptyWorkspace = emptySignup.body.workspace.id as string;
    const emptyResult = await emptyOwner.request(`/workspaces/${emptyWorkspace}/analytics/overview?startDate=2020-01-01&endDate=2020-01-01`);
    assert.equal(emptyResult.body.totalComplaints, 0);
    assert.equal(emptyResult.body.resolutionRate, null);
    assert.equal(emptyResult.body.averageResolutionTimeHours, null);
    assert.equal(emptyResult.body.resolutionTimeSampleSize, 0);
    assert.deepEqual(emptyResult.body.categories, []);
    assert.deepEqual(emptyResult.body.trends, [{ date: "2020-01-01", count: 0 }]);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/analytics/overview?startDate=2025-01-01&endDate=${today}`)).status, 400);
  });

  test("integration credentials, idempotent ingestion, rate limits, webhook outbox, and retries are workspace-scoped", async () => {
    process.env.NODE_ENV = "test";
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const { createApp } = await import("../src/app.js");
    integrationServer = createApp().listen(0, "127.0.0.1");
    await once(integrationServer, "listening");
    const address = integrationServer.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = new ApiClient(origin);
    const signup = await register(owner, `integration.owner.${process.pid}@example.test`);
    const workspaceId = signup.body.workspace.id as string;
    const workspacePath = `/workspaces/${workspaceId}/integrations`;
    assert.equal((await owner.request(`${workspacePath}/settings`, "PATCH", { requestsPerMinute: 600 })).status, 200);

    const member = new ApiClient(origin);
    const memberSignup = await register(member, `integration.member.${process.pid}@example.test`);
    await testPool.query("INSERT INTO tenant_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [workspaceId, memberSignup.body.user.id]);
    const firstCreated = await owner.request(`${workspacePath}/credentials`, "POST", { name: "External CRM" });
    assert.equal(firstCreated.status, 201);
    const firstSecret = firstCreated.body.secret as string;
    assert.match(firstSecret, /^nos_live_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    const firstId = firstCreated.body.credential.id as string;
    const storedHash = await testPool.query<{ secret_hash: Buffer }>("SELECT secret_hash FROM integration_credentials WHERE id = $1", [firstId]);
    assert.equal(storedHash.rows[0].secret_hash.length, 32);
    assert.equal(storedHash.rows[0].secret_hash.toString("utf8").includes(firstSecret), false);
    const listed = await owner.request(`${workspacePath}/credentials`);
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.body).includes(firstSecret), false);
    assert.equal(JSON.stringify(listed.body).includes("secret_hash"), false);
    assert.equal((await member.request(`${workspacePath}/credentials`)).status, 403);
    assert.equal((await member.request(`${workspacePath}/settings`, "PATCH", { enabled: false })).status, 403);

    const rotated = await owner.request(`${workspacePath}/credentials/${firstId}/rotate`, "POST", {});
    assert.equal(rotated.status, 201);
    const activeSecret = rotated.body.secret as string;
    assert.notEqual(activeSecret, firstSecret);
    const integrationRequest = async (token: string, key: string | undefined, body: Record<string, unknown>) => {
      const response = await fetch(`${origin}/api/v1/integrations/complaints`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body)
      });
      const responseBody = response.status === 204 ? {} : await response.json() as Record<string, any>;
      return { status: response.status, body: responseBody, replayed: response.headers.get("idempotent-replayed"), retryAfter: response.headers.get("retry-after") };
    };
    const credentialManagementWithoutSession = await fetch(`${origin}${workspacePath}/credentials`, { headers: { authorization: `Bearer ${activeSecret}` } });
    assert.equal(credentialManagementWithoutSession.status, 401);
    await owner.request(`${workspacePath}/settings`, "PATCH", { enabled: false });
    assert.equal((await integrationRequest(activeSecret, "disabled", { title: "Disabled", description: "Settings disable ingestion." })).status, 403);
    await owner.request(`${workspacePath}/settings`, "PATCH", { enabled: true, requestsPerMinute: 600 });
    assert.equal((await integrationRequest(firstSecret, "revoked-key", { title: "Old", description: "Credential was rotated." })).status, 401);
    assert.equal((await integrationRequest(activeSecret, "injected-workspace", { title: "No", description: "No workspace override.", workspace_id: "other" })).status, 400);
    assert.equal((await integrationRequest(activeSecret, undefined, { title: "No key", description: "Idempotency is required." })).status, 400);
    assert.equal((await integrationRequest("invalid", "bad-auth", { title: "No", description: "Unauthorized." })).status, 401);

    const duplicatePayload = { title: "Concurrent integration complaint", description: "A stable replay must create one record." };
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => integrationRequest(activeSecret, "concurrent-once", duplicatePayload)));
    assert.ok(duplicates.every((result) => result.status === 200 || result.status === 201));
    assert.equal(duplicates.filter((result) => result.status === 201).length, 1);
    assert.equal(duplicates.filter((result) => result.replayed === "true").length, 7);
    const complaintIds = duplicates.map((result) => result.body.complaint.id as string);
    assert.equal(new Set(complaintIds).size, 1);
    assert.equal((await integrationRequest(activeSecret, "concurrent-once", { ...duplicatePayload, title: "Different payload" })).status, 409);
    const createdCount = await testPool.query<{ count: number }>("SELECT count(*)::int AS count FROM complaints WHERE workspace_id = $1", [workspaceId]);
    assert.equal(createdCount.rows[0].count, 1);
    await testPool.query("UPDATE integration_idempotency SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND idempotency_key = 'concurrent-once'", [workspaceId]);
    const afterExpiry = await integrationRequest(activeSecret, "concurrent-once", duplicatePayload);
    assert.equal(afterExpiry.status, 201);
    assert.notEqual(afterExpiry.body.complaint.id, complaintIds[0]);

    const expiring = await owner.request(`${workspacePath}/credentials`, "POST", { name: "Short lived", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await testPool.query("UPDATE integration_credentials SET expires_at = now() - interval '1 second' WHERE id = $1", [expiring.body.credential.id]);
    assert.equal((await integrationRequest(expiring.body.secret, "expired", { title: "Expired", description: "This must be denied." })).status, 401);
    const revoked = await owner.request(`${workspacePath}/credentials`, "POST", { name: "Revoke me" });
    assert.equal((await owner.request(`${workspacePath}/credentials/${revoked.body.credential.id}/revoke`, "POST", {})).status, 200);
    assert.equal((await integrationRequest(revoked.body.secret, "revoked", { title: "Revoked", description: "This must be denied." })).status, 401);

    await owner.request(`${workspacePath}/settings`, "PATCH", { requestsPerMinute: 1 });
    await testPool.query("DELETE FROM workspace_integration_rate_limits WHERE workspace_id = $1", [workspaceId]);
    const limited = await integrationRequest(activeSecret, "rate-one", { title: "Within limit", description: "First request in window." });
    assert.equal(limited.status, 201);
    const blocked = await integrationRequest(activeSecret, "rate-two", { title: "Over limit", description: "Second request in window." });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.retryAfter) > 0);
    await owner.request(`${workspacePath}/settings`, "PATCH", { requestsPerMinute: 600 });

    let responseStatus = 200;
    let received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
    webhookTestServer = createHttpServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => body += chunk);
      request.on("end", () => { received.push({ body, headers: request.headers }); response.writeHead(responseStatus); response.end("safe test response"); });
    });
    webhookTestServer.listen(0, "127.0.0.1"); await once(webhookTestServer, "listening");
    const webhookAddress = webhookTestServer.address(); assert.ok(webhookAddress && typeof webhookAddress !== "string");
    const webhookUrl = `http://127.0.0.1:${webhookAddress.port}/events`;
    assert.equal((await owner.request(`${workspacePath}/webhooks`, "POST", { url: "http://10.0.0.1/events", eventTypes: ["complaint_created"] })).status, 400);
    const encryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    assert.equal((await owner.request(`${workspacePath}/webhooks`, "POST", { url: webhookUrl, eventTypes: ["complaint_created"] })).status, 503);
    process.env.INTEGRATION_ENCRYPTION_KEY = encryptionKey;
    const webhookCreated = await owner.request(`${workspacePath}/webhooks`, "POST", { url: webhookUrl, eventTypes: ["complaint_created"] });
    assert.equal(webhookCreated.status, 201);
    const webhookId = webhookCreated.body.webhook.id as string;
    const webhookSecret = webhookCreated.body.signingSecret as string;
    assert.equal((await owner.request(`${workspacePath}/webhooks`)).body.webhooks.length, 1);
    const storedWebhook = await testPool.query<{ signing_secret_ciphertext: string }>("SELECT signing_secret_ciphertext FROM webhook_endpoints WHERE id = $1", [webhookId]);
    assert.equal(storedWebhook.rows[0].signing_secret_ciphertext.includes(webhookSecret), false);
    const pendingBefore = await testPool.query<{ count: number }>("SELECT count(*)::int AS count FROM webhook_deliveries WHERE workspace_id = $1", [workspaceId]);
    assert.equal(pendingBefore.rows[0].count, 0);
    await testPool.query(`CREATE FUNCTION reject_webhook_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected webhook enqueue failure'; END $$`);
    await testPool.query(`CREATE TRIGGER reject_webhook_job BEFORE INSERT ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION reject_webhook_job()`);
    const failedOutbox = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Rollback outbox", description: "Complaint must roll back with its event job." });
    await testPool.query("DROP TRIGGER reject_webhook_job ON webhook_deliveries");
    await testPool.query("DROP FUNCTION reject_webhook_job()");
    assert.equal(failedOutbox.status, 500);
    const rolledBackComplaint = await testPool.query<{ count: number }>("SELECT count(*)::int AS count FROM complaints WHERE workspace_id = $1 AND title = 'Rollback outbox'", [workspaceId]);
    assert.equal(rolledBackComplaint.rows[0].count, 0);
    const normalComplaint = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Webhook event", description: "The event and job should commit together." });
    assert.equal(normalComplaint.status, 201);
    const queued = await testPool.query<{ count: number }>("SELECT count(*)::int AS count FROM webhook_deliveries WHERE workspace_id = $1", [workspaceId]);
    assert.equal(queued.rows[0].count, 1);
    const { runWebhookDeliveryBatch } = await import("../src/webhook-worker.js");
    assert.equal(await runWebhookDeliveryBatch(), 1);
    assert.equal(received.length, 1);
    const { createWebhookSignature } = await import("../src/integration-security.js");
    const timestamp = Number(received[0].headers["x-nomaanos-timestamp"]);
    assert.equal(received[0].headers["x-nomaanos-signature"], createWebhookSignature(webhookSecret, timestamp, received[0].body));
    assert.equal(received[0].headers["x-nomaanos-event-id"], JSON.parse(received[0].body).id);
    assert.equal(received[0].body.includes("The event and job should commit together"), false);
    const delivered = await owner.request(`${workspacePath}/deliveries`);
    assert.equal(delivered.body.deliveries[0].state, "delivered");
    assert.equal(delivered.body.deliveries[0].attempt_history_count, 1);

    const rotatedWebhook = await owner.request(`${workspacePath}/webhooks/${webhookId}/rotate-secret`, "POST", {});
    assert.equal(rotatedWebhook.status, 200);
    assert.notEqual(rotatedWebhook.body.signingSecret, webhookSecret);
    assert.equal((await owner.request(`${workspacePath}/webhooks/${webhookId}`, "PATCH", { eventTypes: ["status_changed"] })).status, 200);
    const retryComplaint = await owner.request(`/workspaces/${workspaceId}/complaints`, "POST", { title: "Retry setup", description: "Will produce a subscribed transition." });
    await owner.request(`/workspaces/${workspaceId}/complaints/${retryComplaint.body.complaint.id}/status`, "PATCH", { status: "in_progress" });
    responseStatus = 503;
    assert.equal(await runWebhookDeliveryBatch(), 1);
    const rotatedTimestamp = Number(received[1].headers["x-nomaanos-timestamp"]);
    assert.equal(received[1].headers["x-nomaanos-signature"], createWebhookSignature(rotatedWebhook.body.signingSecret, rotatedTimestamp, received[1].body));
    const retryCandidate = await testPool.query<{ id: string; attempt_count: number }>(
      "SELECT id, attempt_count FROM webhook_deliveries WHERE workspace_id = $1 AND state = 'pending'", [workspaceId]
    );
    assert.equal(retryCandidate.rows.length, 1);
    assert.equal(retryCandidate.rows[0].attempt_count, 1);
    await testPool.query("UPDATE webhook_delivery_attempts SET finished_at = NULL, outcome = 'in_progress' WHERE delivery_id = $1 AND attempt_number = 1", [retryCandidate.rows[0].id]);
    await testPool.query("UPDATE webhook_deliveries SET locked_until = now() - interval '1 second', next_attempt_at = now() - interval '1 second' WHERE id = $1", [retryCandidate.rows[0].id]);
    assert.equal(await runWebhookDeliveryBatch(), 1);
    const recoveredAttempt = await testPool.query<{ outcome: string }>("SELECT outcome FROM webhook_delivery_attempts WHERE delivery_id = $1 AND attempt_number = 1", [retryCandidate.rows[0].id]);
    assert.equal(recoveredAttempt.rows[0].outcome, "worker_interrupted");
    const retryScheduled = await testPool.query<{ attempt_count: number; total_attempt_count: number }>("SELECT attempt_count, total_attempt_count FROM webhook_deliveries WHERE id = $1", [retryCandidate.rows[0].id]);
    assert.equal(retryScheduled.rows[0].attempt_count, 2);
    assert.equal(retryScheduled.rows[0].total_attempt_count, 2);
    await testPool.query("UPDATE webhook_deliveries SET attempt_count = 7, next_attempt_at = now() WHERE id = $1", [retryCandidate.rows[0].id]);
    assert.equal(await runWebhookDeliveryBatch(), 1);
    const failed = await testPool.query<{ state: string; total_attempt_count: number }>("SELECT state, total_attempt_count FROM webhook_deliveries WHERE id = $1", [retryCandidate.rows[0].id]);
    assert.equal(failed.rows[0].state, "failed");
    assert.equal(failed.rows[0].total_attempt_count, 3);
    assert.equal((await owner.request(`${workspacePath}/deliveries/${retryCandidate.rows[0].id}/retry`, "POST", {})).status, 202);
    assert.equal((await owner.request(`${workspacePath}/deliveries?state=pending`)).body.deliveries.length, 1);
    assert.equal((await owner.request(`${workspacePath}/webhooks/${webhookId}`, "DELETE", {})).status, 204);
    assert.equal((await owner.request(`${workspacePath}/webhooks`)).body.webhooks.length, 0);
    const outsiderClient = new ApiClient(origin);
    const outsider = await register(outsiderClient, `integration.outsider.${process.pid}@example.test`);
    assert.equal((await owner.request(`/workspaces/${outsider.body.workspace.id}/integrations/credentials`)).status, 404);
    const outsiderWorkspace = outsider.body.workspace.id as string;
    const outsiderComplaint = await outsiderClient.request(`/workspaces/${outsiderWorkspace}/complaints`, "POST", { title: "Other tenant event", description: "Must not attach to another workspace endpoint." });
    const outsiderEvent = await testPool.query<{ id: string }>("SELECT id FROM complaint_activity_events WHERE complaint_id = $1 AND event_type = 'complaint_created'", [outsiderComplaint.body.complaint.id]);
    await assert.rejects(testPool.query(
      "INSERT INTO webhook_deliveries (workspace_id, endpoint_id, event_id, payload) VALUES ($1, $2, $3, '{}'::jsonb)",
      [workspaceId, webhookId, outsiderEvent.rows[0].id]
    ), /foreign key/i);
  });

  test("Day 8 public form and signed Resend ingestion are workspace-scoped and retry-safe", async () => {
    assert.ok(integrationServer, "Day 7 integration API server should still be running");
    const addr = integrationServer.address(); assert.ok(addr && typeof addr !== "string");
    const origin = `http://127.0.0.1:${addr.port}`;
    const owner = new ApiClient(origin);
    const signup = await register(owner, `day8.owner.${process.pid}@example.test`);
    const workspaceId = signup.body.workspace.id as string;
    const base = `/workspaces/${workspaceId}/integrations`;
    const created = await owner.request(`${base}/contact-form`, "POST", {});
    assert.equal(created.status, 201);
    const formToken = created.body.token as string;
    assert.match(formToken, /^[A-Za-z0-9_-]{43}$/);
    const formId = created.body.form.id as string;
    const tokenRecord = await testPool.query<{ form_token_hash: Buffer }>("SELECT form_token_hash FROM public_contact_forms WHERE id=$1", [formId]);
    assert.equal(tokenRecord.rows[0].form_token_hash.length, 32);
    assert.equal(tokenRecord.rows[0].form_token_hash.toString("hex"), createHash("sha256").update(formToken).digest("hex"));
    assert.equal(JSON.stringify((await owner.request(`${base}/contact-form`)).body).includes(formToken), false);
    assert.equal((await owner.request(`${base}/contact-form`, "POST", {})).status, 409);
    const member = new ApiClient(origin);
    const memberSignup = await register(member, `day8.member.${process.pid}@example.test`);
    await testPool.query("INSERT INTO tenant_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')", [workspaceId, memberSignup.body.user.id]);
    assert.equal((await member.request(`${base}/contact-form`)).status, 403);
    const embedConfig = {
      displayName: "Website complaints",
      fields: {
        name: { enabled: false, required: false }, email: { enabled: false, required: false },
        subject: { enabled: true, required: true }, description: { enabled: true, required: true }, category: { enabled: false, required: false }
      },
      allowedOrigins: ["https://customer.example"]
    };
    assert.equal((await member.request(`${base}/embed-forms`, "GET")).status, 403);
    assert.equal((await owner.request(`${base}/embed-forms`, "POST", { ...embedConfig, allowedOrigins: ["*"] })).status, 400);
    assert.equal((await owner.request(`${base}/embed-forms/not-a-uuid/rotate`, "POST", {})).status, 404);
    const createdEmbed = await owner.request(`${base}/embed-forms`, "POST", embedConfig);
    assert.equal(createdEmbed.status, 201);
    const embedToken = createdEmbed.body.token as string;
    const embedFormId = createdEmbed.body.form.id as string;
    assert.equal(createdEmbed.body.formUrl, `http://localhost:3000/contact/${embedToken}`);
    assert.equal((await member.request(`${base}/embed-forms`, "GET")).status, 403);
    assert.equal((await owner.request(`${base}/embed-forms`, "GET")).body.forms.length, 1);
    const embedHash = await testPool.query<{ form_token_hash: Buffer; form_type: string }>("SELECT form_token_hash,form_type FROM public_contact_forms WHERE id=$1", [embedFormId]);
    assert.equal(embedHash.rows[0].form_type, "embed");
    assert.equal(embedHash.rows[0].form_token_hash.toString("hex"), createHash("sha256").update(embedToken).digest("hex"));
    assert.equal((await owner.request(`/workspaces/${memberSignup.body.workspace.id}/integrations/embed-forms`)).status, 404);
    const publicEmbed = await fetch(`${origin}/public/contact/${embedToken}`);
    assert.deepEqual((await publicEmbed.json() as { form: { displayName: string; allowedOrigins: string[] } }).form, {
      active: true, displayName: "Website complaints", fields: embedConfig.fields, allowedOrigins: embedConfig.allowedOrigins
    });
    assert.equal((await owner.request(`${base}/contact-form`, "PATCH", { enabled: false })).status, 200);
    assert.equal((await fetch(`${origin}/public/contact/${embedToken}`)).status, 200, "disabling the hosted link must not disable a separate embed form");
    assert.equal((await owner.request(`${base}/contact-form`, "PATCH", { enabled: true })).status, 200);
    assert.equal((await owner.request(`${base}/embed-forms/${embedFormId}`, "PATCH", embedConfig)).status, 200);
    await testPool.query("DELETE FROM workspace_contact_rate_limits WHERE workspace_id=$1", [workspaceId]);
    const embedSubmitBody: Record<string, unknown> = { subject: "Embedded issue", description: "A package is missing.", website: "" };
    const embedSubmit = async (key: string, body: Record<string, unknown> = embedSubmitBody) => fetch(`${origin}/public/contact/${embedToken}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body)
    });
    const embedCreatedComplaint = await embedSubmit("embed-idempotency");
    assert.equal(embedCreatedComplaint.status, 201);
    assert.equal((await embedSubmit("embed-idempotency")).status, 200);
    assert.equal((await embedSubmit("embed-idempotency", { ...embedSubmitBody, subject: "Changed title" })).status, 409);
    assert.equal((await embedSubmit("embed-invalid", { ...embedSubmitBody, name: "Not configured" })).status, 400);
    assert.equal((await owner.request(`${base}/embed-forms/${embedFormId}/revoke`, "POST", {})).status, 204);
    assert.equal((await fetch(`${origin}/public/contact/${embedToken}`)).status, 404);
    assert.equal((await owner.request(`${base}/embed-forms/${embedFormId}/rotate`, "POST", {})).status, 200);
    assert.equal((await fetch(`${origin}/public/contact/not-a-real-token`)).status, 404);

    const contactBody = { name: "Customer Example", email: "customer@example.test", subject: "Order issue", description: "The order arrived damaged.", category: "delivery", website: "" };
    const submit = async (key: string, body: Record<string, unknown>, target = formToken) => fetch(`${origin}/public/contact/${target}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body)
    });
    assert.equal((await submit("workspace-injection", { ...contactBody, workspace_id: "another workspace" })).status, 400);
    assert.equal((await submit("bad-email", { ...contactBody, email: "bad" })).status, 400);
    assert.equal((await submit("missing-required-name", { ...contactBody, name: "   " })).status, 400);
    const largeResponse = await fetch(`${origin}/public/contact/${formToken}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "large-body" }, body: JSON.stringify({ ...contactBody, description: "x".repeat(13000) }) });
    assert.equal(largeResponse.status, 413);
    const spam = await submit("honeypot", { ...contactBody, website: "https://spam.example" });
    assert.equal(spam.status, 202);
    assert.equal((await spam.json() as Record<string, unknown>).status, "accepted");
    let publicCount = await testPool.query<{ count: number }>("SELECT count(*)::int count FROM complaints WHERE workspace_id=$1 AND source='contact_form'", [workspaceId]);
    assert.equal(publicCount.rows[0].count, 1, "the configured embed form created exactly one complaint; the hosted honeypot created none");

    await testPool.query("DELETE FROM public_contact_rate_limits WHERE form_id=$1", [formId]);
    await testPool.query("DELETE FROM workspace_contact_rate_limits WHERE workspace_id=$1", [workspaceId]);
    const first = await submit("contact-one", contactBody);
    assert.equal(first.status, 201);
    const firstResult = await first.json() as Record<string, any>;
    assert.equal(typeof firstResult.reference, "string");
    const replay = await submit("contact-one", contactBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(await replay.json(), firstResult);
    assert.equal((await submit("contact-one", { ...contactBody, subject: "Different" })).status, 409);
    const storedContact = await testPool.query<{ title: string; customer_name: string; customer_email: string; submitted_category: string; source: string }>(
      "SELECT title,customer_name,customer_email,submitted_category,source FROM complaints WHERE workspace_id=$1 AND source='contact_form'", [workspaceId]
    );
    assert.equal(storedContact.rows.length, 2);
    assert.ok(storedContact.rows.some((row) => row.title === "Order issue" && row.customer_name === "Customer Example" && row.customer_email === "customer@example.test" && row.submitted_category === "delivery" && row.source === "contact_form"));
    assert.ok(storedContact.rows.some((row) => row.title === "Embedded issue" && row.customer_name === null && row.customer_email === null && row.submitted_category === null && row.source === "contact_form"));

    await testPool.query("DELETE FROM public_contact_rate_limits WHERE form_id=$1", [formId]);
    await testPool.query("DELETE FROM workspace_contact_rate_limits WHERE workspace_id=$1", [workspaceId]);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => submit("parallel-contact", contactBody)));
    assert.ok(concurrent.every((response) => response.status === 200 || response.status === 201));
    assert.equal(concurrent.filter((response) => response.status === 201).length, 1);
    assert.equal(concurrent.filter((response) => response.headers.get("idempotent-replayed") === "true").length, 7);

    await testPool.query("DELETE FROM public_contact_rate_limits WHERE form_id=$1", [formId]);
    await testPool.query("DELETE FROM workspace_contact_rate_limits WHERE workspace_id=$1", [workspaceId]);
    const rateResponses = await Promise.all(Array.from({ length: 9 }, (_, index) => submit(`rate-${index}`, { ...contactBody, subject: `Rate test ${index}` })));
    assert.equal(rateResponses.filter((response) => response.status === 429).length, 1);
    const blocked = rateResponses.find((response) => response.status === 429)!;
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    await owner.request(`${base}/contact-form`, "PATCH", { enabled: false });
    assert.equal((await fetch(`${origin}/public/contact/${formToken}`)).status, 404);
    const rotated = await owner.request(`${base}/contact-form/rotate`, "POST", {});
    assert.equal(rotated.status, 200);
    assert.equal((await fetch(`${origin}/public/contact/${formToken}`)).status, 404);
    assert.equal((await fetch(`${origin}/public/contact/${rotated.body.token}`)).status, 200);

    process.env.RESEND_API_KEY = "re_day8_unit_test_key";
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${randomBytes(32).toString("base64")}`;
    process.env.RESEND_INBOUND_DOMAIN = "account-id.resend.app";
    const emailRoute = await owner.request(`${base}/inbound-email`, "POST", {});
    assert.equal(emailRoute.status, 201);
    const inboundAddress = emailRoute.body.route.inboundAddress as string;
    assert.match(inboundAddress, /^nomaan-[a-f0-9]{64}@account-id\.resend\.app$/);
    assert.equal(emailRoute.body.status, "awaiting_provider_setup");
    const routeRecord = await testPool.query<{ id: string; routing_token_hash: Buffer; recipient_ciphertext: string; recipient_hash: Buffer }>(
      "SELECT id,routing_token_hash,recipient_ciphertext,recipient_hash FROM workspace_inbound_email_routes WHERE workspace_id=$1", [workspaceId]
    );
    assert.equal(routeRecord.rows[0].routing_token_hash.length, 32);
    assert.equal(routeRecord.rows[0].recipient_hash.length, 32);
    assert.equal(routeRecord.rows[0].recipient_hash.toString("hex"), createHash("sha256").update(inboundAddress.toLowerCase()).digest("hex"));
    assert.equal(routeRecord.rows[0].recipient_ciphertext.includes(inboundAddress), false);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const providerEmailId = `day8-${process.pid}-received`;
    const eventId = `msg_day8_${process.pid}_1`;
    const event = { type: "email.received", created_at: new Date().toISOString(), data: {
      email_id: providerEmailId, created_at: new Date().toISOString(), from: "Customer Example <customer@example.test>",
      to: [inboundAddress], message_id: `<day8-${process.pid}@example.test>`, subject: "Email complaint", attachments: []
    } };
    const rawEvent = JSON.stringify(event);
    const sign = (id: string, timestamp: number, raw: string) => createHmac("sha256", Buffer.from(process.env.RESEND_WEBHOOK_SECRET!.slice(6), "base64"))
      .update(`${id}.${timestamp}.${raw}`).digest("base64");
    const sendSigned = (id: string, timestamp: number, raw = rawEvent, sig = sign(id, timestamp, raw)) => fetch(`${origin}/webhooks/resend`, {
      method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}` }, body: raw
    });
    assert.equal((await fetch(`${origin}/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json" }, body: rawEvent })).status, 400);
    assert.equal((await sendSigned(`msg_bad_${process.pid}`, nowSeconds, rawEvent, "invalid-signature")).status, 400);
    assert.equal((await sendSigned(`msg_stale_${process.pid}`, nowSeconds - 600)).status, 400);
    const unsupported = await sendSigned(`msg_unsupported_${process.pid}`, nowSeconds, JSON.stringify({ type: "email.sent", data: {} }));
    assert.equal(unsupported.status, 400);
    const unknownEvent = structuredClone(event);
    unknownEvent.data.email_id = `day8-${process.pid}-unknown`;
    unknownEvent.data.to = ["nomaan-unknown@account-id.resend.app"];
    const unknownResponse = await sendSigned(`msg_unknown_${process.pid}`, nowSeconds, JSON.stringify(unknownEvent));
    assert.equal(unknownResponse.status, 202);
    const unknownState = await testPool.query<{ status: string; error_code: string }>("SELECT status,error_code FROM resend_inbound_events WHERE provider_event_id=$1", [`msg_unknown_${process.pid}`]);
    assert.deepEqual(unknownState.rows[0], { status: "rejected", error_code: "unknown_recipient" });

    const acceptedEmail = await sendSigned(eventId, nowSeconds);
    assert.equal(acceptedEmail.status, 202);
    assert.deepEqual(await acceptedEmail.json(), { accepted: true, duplicate: false });
    const replayEvent = await sendSigned(eventId, nowSeconds);
    assert.equal(replayEvent.status, 200);
    assert.deepEqual(await replayEvent.json(), { accepted: true, duplicate: true });
    const sameEmailDifferentEvent = await sendSigned(`msg_duplicate_email_${process.pid}`, nowSeconds);
    assert.equal(sameEmailDifferentEvent.status, 200);
    assert.equal((await testPool.query("SELECT id FROM resend_inbound_events WHERE provider_email_id=$1", [providerEmailId])).rowCount, 1);

    const { runInboundEmailBatch } = await import("../src/inbound-email-worker.js");
    const mockEmail: ResendReceivedEmail = { object: "email", id: providerEmailId, to: [inboundAddress], from: event.data.from,
      created_at: new Date().toISOString(), subject: event.data.subject,
      html: null, text: "My package arrived damaged. Please help.", headers: { "auto-submitted": "no" }, message_id: event.data.message_id,
      attachments: [{ id: "att-1", filename: "../../receipt.pdf", size: 1234, content_type: "application/pdf", content_id: null, content_disposition: null },
        { id: "att-2", filename: "malware.exe", size: 10, content_type: "application/x-msdownload", content_id: null, content_disposition: null }] };
    const acceptedQueueRow = await testPool.query<{ status: string; error_code: string | null; workspace_id: string | null; route_id: string | null }>(
      "SELECT status,error_code,workspace_id,route_id FROM resend_inbound_events WHERE provider_event_id=$1", [eventId]
    );
    assert.deepEqual(acceptedQueueRow.rows[0], { status: "received", error_code: null, workspace_id: workspaceId, route_id: routeRecord.rows[0].id });
    const mockResend = async (requestedEmailId: string) => {
      assert.equal(requestedEmailId, providerEmailId);
      return mockEmail;
    };
    assert.equal(await runInboundEmailBatch(mockResend), 1);
    const processed = await testPool.query<{ status: string; complaint_id: string; attachment_metadata: Array<{ filename: string; status: string }> }>(
      "SELECT status,complaint_id,attachment_metadata FROM resend_inbound_events WHERE provider_event_id=$1", [eventId]
    );
    assert.equal(processed.rows[0].status, "processed");
    assert.deepEqual(processed.rows[0].attachment_metadata.map((item) => [item.filename, item.status]), [["receipt.pdf", "metadata_only"], ["malware.exe", "unsupported"]]);
    const inboundComplaint = await testPool.query<{ workspace_id: string; title: string; customer_name: string; customer_email: string; source: string }>(
      "SELECT workspace_id,title,customer_name,customer_email,source FROM complaints WHERE id=$1", [processed.rows[0].complaint_id]
    );
    assert.deepEqual(inboundComplaint.rows[0], { workspace_id: workspaceId, title: "Email complaint", customer_name: "Customer Example", customer_email: "customer@example.test", source: "inbound_email" });
    publicCount = await testPool.query("SELECT count(*)::int count FROM complaints WHERE workspace_id=$1 AND source='inbound_email'", [workspaceId]);
    assert.equal(publicCount.rows[0].count, 1);

    const loopEvent = structuredClone(event);
    loopEvent.data.email_id = `day8-${process.pid}-loop`;
    loopEvent.data.message_id = `<loop-${process.pid}@example.test>`;
    const loopId = `msg_loop_${process.pid}`;
    await sendSigned(loopId, nowSeconds, JSON.stringify(loopEvent));
    const loopMock = async () => ({ ...mockEmail, id: loopEvent.data.email_id, from: "mailer-daemon@example.test", message_id: `<loop-${process.pid}@example.test>` });
    assert.equal(await runInboundEmailBatch(loopMock), 1);
    const loopState = await testPool.query<{ status: string; error_code: string }>("SELECT status,error_code FROM resend_inbound_events WHERE provider_event_id=$1", [loopId]);
    assert.equal(loopState.rows[0].status, "rejected");
    assert.equal(loopState.rows[0].error_code, "suppressed_automated_sender");

    const failureEvent = structuredClone(event);
    failureEvent.data.email_id = `day8-${process.pid}-failure`;
    failureEvent.data.message_id = `<failure-${process.pid}@example.test>`;
    const failureId = `msg_failure_${process.pid}`;
    await sendSigned(failureId, nowSeconds, JSON.stringify(failureEvent));
    const failingResend = async () => { throw new Error("private provider error"); };
    assert.equal(await runInboundEmailBatch(failingResend), 1);
    const failedAttempt = await testPool.query<{ status: string; attempt_count: number; error_code: string; next_attempt_at: Date }>("SELECT status,attempt_count,error_code,next_attempt_at FROM resend_inbound_events WHERE provider_event_id=$1", [failureId]);
    assert.equal(failedAttempt.rows[0].status, "received");
    assert.equal(failedAttempt.rows[0].attempt_count, 1);
    assert.equal(failedAttempt.rows[0].error_code, "provider_or_processing_error");
    assert.ok(failedAttempt.rows[0].next_attempt_at > new Date());
    await testPool.query("UPDATE resend_inbound_events SET status='processing', locked_until=now()-interval '1 second', next_attempt_at=now()-interval '1 second' WHERE provider_event_id=$1", [failureId]);
    const recoveryMock = async () => ({ ...mockEmail, id: failureEvent.data.email_id, message_id: `<recovered-${process.pid}@example.test>` });
    assert.equal(await runInboundEmailBatch(recoveryMock), 1);
    const recovered = await testPool.query<{ status: string; attempt_count: number }>("SELECT status,attempt_count FROM resend_inbound_events WHERE provider_event_id=$1", [failureId]);
    assert.equal(recovered.rows[0].status, "processed");
    assert.equal(recovered.rows[0].attempt_count, 2);
  });

  test("Meta WhatsApp and Instagram webhook ingestion verifies signatures, maps tenants, deduplicates, and tracks conversations", async () => {
    assert.ok(sharedMetaOwner && sharedMetaWorkspaceId);
    const appSecret = `fixture-${randomBytes(24).toString("hex")}`;
    const verifyToken = `verify-${randomBytes(24).toString("hex")}`;
    process.env.META_APP_SECRET = appSecret;
    process.env.META_WEBHOOK_VERIFY_TOKEN = verifyToken;
    process.env.PUBLIC_API_BASE_URL = "https://api.example.test";
    const owner = sharedMetaOwner;
    const workspaceId = sharedMetaWorkspaceId;
    const otherWorkspace = await owner.request("/workspaces", "POST", { name: "Other Meta Workspace" });
    assert.equal(otherWorkspace.status, 201);
    const otherWorkspaceId = otherWorkspace.body.workspace.id as string;

    const config = await owner.request(`/workspaces/${workspaceId}/integrations/meta-social`);
    assert.equal(config.status, 200);
    assert.equal(config.body.callbackUrl, "https://api.example.test/webhooks/meta");
    assert.deepEqual(config.body.configuration, { appSecretConfigured: true, verificationTokenConfigured: true });
    const anonymous = new ApiClient();
    assert.equal((await anonymous.request(`/workspaces/${workspaceId}/integrations/meta-social`)).status, 401);

    assert.equal((await owner.request(`/workspaces/${workspaceId}/integrations/meta-social`, "POST", {
      provider: "whatsapp", providerAccountId: "wa-phone-meta-test", businessAccountId: "wa-business-meta-test", displayName: "Support WhatsApp"
    })).status, 400);
    const ownerId = (await owner.request("/auth/me")).body.user.id as string;
    const seededWhatsApp = await testPool.query<{ id: string }>(
      `INSERT INTO meta_social_connections
         (workspace_id, provider, provider_account_id, business_account_id, display_name, created_by)
       VALUES ($1, 'whatsapp', 'wa-phone-meta-test', 'wa-business-meta-test', 'Support WhatsApp', $2)
       RETURNING id`,
      [workspaceId, ownerId]
    );
    const whatsapp = { body: { connection: { id: seededWhatsApp.rows[0].id } } };
    const instagram = await owner.request(`/workspaces/${otherWorkspaceId}/integrations/meta-social`, "POST", {
      provider: "instagram", providerAccountId: "ig-account-other-test", displayName: "Other Instagram"
    });
    assert.equal(instagram.status, 201);
    assert.equal((await owner.request(`/workspaces/${otherWorkspaceId}/integrations/meta-social`, "POST", {
      provider: "whatsapp", providerAccountId: "wa-phone-meta-test", businessAccountId: "wa-business-meta-test", displayName: "Cross tenant"
    })).status, 400);
    await testPool.query("UPDATE tenant_memberships SET role='member' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, ownerId]);
    assert.equal((await owner.request(`/workspaces/${workspaceId}/integrations/meta-social`)).status, 403);
    await testPool.query("UPDATE tenant_memberships SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, ownerId]);

    const verification = await fetch(`${baseUrl}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=challenge-123`);
    assert.equal(verification.status, 200);
    assert.equal(await verification.text(), "challenge-123");
    const invalidVerification = await fetch(`${baseUrl}/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`);
    assert.equal(invalidVerification.status, 403);

    const sign = (raw: Buffer | string) => `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
    const sendMeta = (raw: string, signature = sign(raw)) => fetch(`${baseUrl}/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: raw
    });
    const sampleRaw = Buffer.from('{"object":"instagram","entry":[]}');
    assert.equal(metaSignatureVerifier(sampleRaw, sign(sampleRaw), appSecret), true);
    assert.equal(metaSignatureVerifier(sampleRaw, sign(Buffer.from(`${sampleRaw.toString()} `)), appSecret), false);
    assert.equal((await fetch(`${baseUrl}/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json" }, body: sampleRaw })).status, 401);
    assert.equal((await sendMeta(sampleRaw.toString(), "sha256=" + "0".repeat(64))).status, 401);
    assert.equal((await sendMeta("{invalid-json")).status, 400);
    assert.throws(() => metaParser({ object: "whatsapp_business_account" }));

    const whatsappPayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "wa-business-meta-test",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "wa-phone-meta-test", display_phone_number: "15550001111" },
            contacts: [{ profile: { name: "Customer One" }, wa_id: "15551234567" }],
            messages: [
              { from: "15551234567", id: `wamid.first.${process.pid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "My delivery is late." } },
              { from: "15551234567", id: `wamid.followup.${process.pid}`, timestamp: String(Math.floor(Date.now() / 1000) + 1), type: "image", image: { id: "media-id-1", mime_type: "image/jpeg", sha256: "ignored", url: "https://untrusted.example/file" } }
            ],
            statuses: [{ id: "outgoing-message", status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "15551234567" }]
          }
        }]
      }]
    };
    const whatsappRaw = JSON.stringify(whatsappPayload);
    const waResult = await sendMeta(whatsappRaw);
    assert.equal(waResult.status, 200);
    assert.deepEqual(await waResult.json(), { accepted: true, processed: 2, duplicates: 0, rejected: 0 });
    const waComplaints = await testPool.query<{ id: string; workspace_id: string; source: string; customer_name: string }>(
      "SELECT id,workspace_id,source,customer_name FROM complaints WHERE source='whatsapp' AND workspace_id=$1", [workspaceId]
    );
    assert.equal(waComplaints.rows.length, 1);
    assert.equal(waComplaints.rows[0].customer_name, "Customer One");
    const waConversation = await testPool.query<{ conversation_count: number; message_count: number; metadata: string }>(
      `SELECT (SELECT count(*)::int FROM meta_social_conversations WHERE complaint_id=$1) conversation_count,
              (SELECT count(*)::int FROM meta_social_messages WHERE connection_id=$2) message_count,
              (SELECT string_agg(attachment_metadata::text, '') FROM meta_social_messages WHERE connection_id=$2) metadata`,
      [waComplaints.rows[0].id, whatsapp.body.connection.id]
    );
    assert.equal(waConversation.rows[0].conversation_count, 1);
    assert.equal(waConversation.rows[0].message_count, 2);
    assert.doesNotMatch(waConversation.rows[0].metadata, /untrusted\.example/);
    const duplicateWa = await sendMeta(whatsappRaw);
    assert.deepEqual(await duplicateWa.json(), { accepted: true, processed: 0, duplicates: 2, rejected: 0 });

    const timeline = await owner.request(`/workspaces/${workspaceId}/complaints/${waComplaints.rows[0].id}/activity`);
    assert.equal(timeline.status, 200);
    const socialTimeline = timeline.body.events.filter((event: { event_type: string }) => event.event_type === "social_message_received");
    assert.equal(socialTimeline.length, 2);
    assert.ok(socialTimeline.some((event: { social_message: string }) => event.social_message === "My delivery is late."));
    assert.ok(socialTimeline.some((event: { social_message: string }) => event.social_message.includes("Attachment content is not downloaded")));

    const statusOnly = {
      object: "whatsapp_business_account",
      entry: [{ id: "wa-business-meta-test", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "wa-phone-meta-test" }, statuses: [{ id: "outgoing-message", status: "read" }]
      } }] }]
    };
    const statusResponse = await sendMeta(JSON.stringify(statusOnly));
    assert.deepEqual(await statusResponse.json(), { accepted: true, processed: 0, duplicates: 0, rejected: 0 });

    const mismatchedBusinessPayload = structuredClone(whatsappPayload);
    mismatchedBusinessPayload.entry[0].id = "untrusted-business-id";
    mismatchedBusinessPayload.entry[0].changes[0].value.messages = [{
      from: "15551234567", id: `wamid.wrong-business.${process.pid}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Must not cross account mapping." }
    }];
    const mismatchResponse = await sendMeta(JSON.stringify(mismatchedBusinessPayload));
    assert.deepEqual(await mismatchResponse.json(), { accepted: true, processed: 0, duplicates: 0, rejected: 1 });
    const connectionStatus = await testPool.query<{ last_error_code: string }>(
      "SELECT last_error_code FROM meta_social_connections WHERE id=$1", [whatsapp.body.connection.id]
    );
    assert.equal(connectionStatus.rows[0].last_error_code, "unknown_account");
    const waCountAfterMismatch = await testPool.query<{ count: number }>(
      "SELECT count(*)::int count FROM complaints WHERE workspace_id=$1 AND source='whatsapp'", [workspaceId]
    );
    assert.equal(waCountAfterMismatch.rows[0].count, 1);

    const instagramPayload = {
      object: "instagram",
      entry: [{
        id: "ig-account-other-test",
        time: Date.now(),
        messaging: [
          { sender: { id: "ig-customer-7" }, recipient: { id: "ig-account-other-test" }, timestamp: Date.now(),
            message: { mid: `ig-message-${process.pid}`, text: "I need help with my account." } },
          { sender: { id: "ig-account-other-test" }, recipient: { id: "ig-customer-7" }, timestamp: Date.now(),
            message: { mid: "business-echo", text: "Outgoing message", is_echo: true } }
        ]
      }]
    };
    const igRaw = JSON.stringify(instagramPayload);
    const igResponse = await sendMeta(igRaw);
    assert.deepEqual(await igResponse.json(), { accepted: true, processed: 1, duplicates: 0, rejected: 0 });
    assert.deepEqual(await (await sendMeta(igRaw)).json(), { accepted: true, processed: 0, duplicates: 1, rejected: 0 });
    const igComplaints = await testPool.query<{ id: string; workspace_id: string; source: string }>(
      "SELECT id,workspace_id,source FROM complaints WHERE source='instagram' AND workspace_id=$1", [otherWorkspaceId]
    );
    assert.equal(igComplaints.rows.length, 1);
    assert.equal(igComplaints.rows[0].source, "instagram");

    const concurrentMessage = {
      object: "instagram",
      entry: [{
        id: "ig-account-other-test",
        messaging: [{ sender: { id: "ig-customer-concurrent" }, recipient: { id: "ig-account-other-test" }, timestamp: Date.now(),
          message: { mid: `ig-message-concurrent-${process.pid}`, text: "Concurrent duplicate test." } }]
      }]
    };
    const concurrentRaw = JSON.stringify(concurrentMessage);
    const concurrentDeliveries = await Promise.all(Array.from({ length: 6 }, () => sendMeta(concurrentRaw)));
    assert.ok(concurrentDeliveries.every((response) => response.status === 200));
    const instagramCount = await testPool.query<{ count: number }>(
      "SELECT count(*)::int count FROM complaints WHERE workspace_id=$1 AND source='instagram'", [otherWorkspaceId]
    );
    assert.equal(instagramCount.rows[0].count, 2);

    const failureId = `wamid.database-failure.${process.pid}`;
    await testPool.query(`CREATE FUNCTION reject_meta_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected meta event failure'; END; $$`);
    await testPool.query("CREATE TRIGGER reject_meta_event_insert BEFORE INSERT ON meta_social_events FOR EACH ROW EXECUTE FUNCTION reject_meta_event_insert()");
    const failurePayload = structuredClone(whatsappPayload);
    failurePayload.entry[0].changes[0].value.messages = [{
      from: "15551234567", id: failureId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Retry durable processing." }
    }];
    const failureRaw = JSON.stringify(failurePayload);
    assert.equal((await sendMeta(failureRaw)).status, 503);
    await testPool.query("DROP TRIGGER reject_meta_event_insert ON meta_social_events");
    await testPool.query("DROP FUNCTION reject_meta_event_insert()");
    assert.deepEqual(await (await sendMeta(failureRaw)).json(), { accepted: true, processed: 1, duplicates: 0, rejected: 0 });

    const disconnected = await owner.request(
      `/workspaces/${workspaceId}/integrations/meta-social/${whatsapp.body.connection.id}/disconnect`, "POST", {}
    );
    assert.equal(disconnected.status, 200);
    const afterDisconnect = structuredClone(whatsappPayload);
    afterDisconnect.entry[0].changes[0].value.messages = [{
      from: "15551234567", id: `wamid.disconnected.${process.pid}`, timestamp: String(Math.floor(Date.now() / 1000)),
      type: "text", text: { body: "This revoked connection must not ingest." }
    }];
    assert.deepEqual(await (await sendMeta(JSON.stringify(afterDisconnect))).json(), {
      accepted: true, processed: 0, duplicates: 0, rejected: 1
    });

    process.env.META_APP_ID = "meta-app-fixture";
    process.env.META_LOGIN_CONFIG_ID = "meta-login-config-fixture";
    process.env.META_GRAPH_API_VERSION = "v26.0";
    process.env.META_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.WEB_ORIGIN = "https://nomaan-web.example.test";
    const graphCalls: string[] = [];
    const mockedGraphApi = {
      async exchangeCode(code: string) {
        graphCalls.push(`exchange:${code}`);
        return { accessToken: "fixture-private-meta-access-token", expiresAt: new Date(Date.now() + 60 * 86400000) };
      },
      async validateToken(token: string) {
        assert.equal(token, "fixture-private-meta-access-token");
        graphCalls.push("validate-token");
      },
      async validateAssets(token: string, assets: { phoneNumberId: string; wabaId: string }) {
        assert.equal(token, "fixture-private-meta-access-token");
        assert.deepEqual(assets, { phoneNumberId: "123456789012345", wabaId: "987654321098765" });
        graphCalls.push("validate-assets");
        return { id: assets.phoneNumberId, displayPhoneNumber: "+1 555 0100", verifiedName: "NomaanOS Support" };
      },
      async subscribe(_token: string, wabaId: string) {
        assert.equal(wabaId, "987654321098765");
        graphCalls.push("subscribe");
      },
      async unsubscribe(_token: string, wabaId: string) {
        assert.equal(wabaId, "987654321098765");
        graphCalls.push("unsubscribe");
      }
    };
    const { createApp } = await import("../src/app.js");
    whatsappTestServer = createApp({ whatsappGraphApi: mockedGraphApi }).listen(0, "127.0.0.1");
    await once(whatsappTestServer, "listening");
    const whatsappAddress = whatsappTestServer.address();
    assert.ok(whatsappAddress && typeof whatsappAddress !== "string");
    const whatsappBaseUrl = `http://127.0.0.1:${whatsappAddress.port}`;
    const whatsappOwner = new ApiClient(whatsappBaseUrl);
    whatsappOwner.cookie = owner.cookie;
    whatsappOwner.csrfToken = owner.csrfToken;
    const setup = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/config`);
    assert.equal(setup.status, 200);
    assert.equal(setup.body.ready, true);
    assert.equal(setup.body.appId, "meta-app-fixture");
    assert.equal(setup.body.loginConfigId, "meta-login-config-fixture");
    assert.equal(setup.body.callbackUrl, "https://api.example.test/webhooks/meta");
    assert.equal(Object.keys(setup.body).some((key) => /secret|token|encryption/i.test(key)), false);
    assert.equal((await new ApiClient(whatsappBaseUrl).request(`/workspaces/${workspaceId}/integrations/whatsapp/config`)).status, 401);

    const invalidConfig = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/onboarding`, "POST", {});
    assert.equal(invalidConfig.status, 201);
    process.env.META_LOGIN_CONFIG_ID = "";
    const missingConfig = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/onboarding`, "POST", {});
    assert.equal(missingConfig.status, 503);
    assert.ok(missingConfig.body.missing.includes("META_LOGIN_CONFIG_ID"));
    process.env.META_LOGIN_CONFIG_ID = "meta-login-config-fixture";
    const expiredState = invalidConfig.body.state as string;
    await testPool.query(
      "UPDATE whatsapp_onboarding_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
      [createHash("sha256").update(expiredState).digest()]
    );
    const completion = { state: expiredState, code: "one-time-code", phoneNumberId: "123456789012345", wabaId: "987654321098765" };
    assert.equal((await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/complete`, "POST", completion)).status, 400);

    const issuedState = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/onboarding`, "POST", {});
    assert.equal(issuedState.status, 201);
    const finished = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/complete`, "POST", {
      state: issuedState.body.state, code: "exchangeable-code-fixture",
      phoneNumberId: "123456789012345", wabaId: "987654321098765"
    });
    assert.equal(finished.status, 201);
    assert.equal(finished.body.connection.authorized, true);
    assert.equal(finished.body.connection.phone_display_number, "+1 555 0100");
    assert.equal(finished.body.connection.phone_verified_name, "NomaanOS Support");
    assert.equal(JSON.stringify(finished.body).includes("fixture-private-meta-access-token"), false);
    assert.deepEqual(graphCalls.slice(-4), ["exchange:exchangeable-code-fixture", "validate-token", "validate-assets", "subscribe"]);
    assert.equal((await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/whatsapp/complete`, "POST", {
      state: issuedState.body.state, code: "exchangeable-code-fixture",
      phoneNumberId: "123456789012345", wabaId: "987654321098765"
    })).status, 400);

    const storedToken = await testPool.query<{ access_token_ciphertext: string; status: string }>(
      "SELECT access_token_ciphertext,status FROM meta_social_connections WHERE provider='whatsapp' AND provider_account_id=$1",
      ["123456789012345"]
    );
    assert.equal(storedToken.rows[0].status, "active");
    assert.doesNotMatch(storedToken.rows[0].access_token_ciphertext, /fixture-private-meta-access-token/);
    const { decryptMetaAccessToken } = await import("../src/meta-token-security.js");
    assert.equal(decryptMetaAccessToken(storedToken.rows[0].access_token_ciphertext), "fixture-private-meta-access-token");
    const listedConnections = await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/meta-social`);
    const connectedPhone = listedConnections.body.connections.find((entry: { provider_account_id: string }) => entry.provider_account_id === "123456789012345");
    assert.equal(connectedPhone.authorized, true);
    assert.equal(Object.keys(connectedPhone).some((key) => /access_token_ciphertext|access_token$/i.test(key)), false);

    const foreignState = await whatsappOwner.request(`/workspaces/${otherWorkspaceId}/integrations/whatsapp/onboarding`, "POST", {});
    const foreignComplete = await whatsappOwner.request(`/workspaces/${otherWorkspaceId}/integrations/whatsapp/complete`, "POST", {
      state: foreignState.body.state, code: "different-code",
      phoneNumberId: "123456789012345", wabaId: "987654321098765"
    });
    assert.equal(foreignComplete.status, 409);
    const foreignListing = await whatsappOwner.request(`/workspaces/${otherWorkspaceId}/integrations/meta-social`);
    assert.equal(foreignListing.body.connections.some((entry: { provider_account_id: string }) => entry.provider_account_id === "123456789012345"), false);

    const connectionId = connectedPhone.id as string;
    assert.equal((await whatsappOwner.request(`/workspaces/${workspaceId}/integrations/meta-social/${connectionId}/disconnect`, "POST", {})).status, 200);
    assert.equal(graphCalls.at(-1), "unsubscribe");
    const retainedConnection = await testPool.query<{ status: string; access_token_ciphertext: string | null }>(
      "SELECT status,access_token_ciphertext FROM meta_social_connections WHERE id=$1", [connectionId]
    );
    assert.equal(retainedConnection.rows[0].status, "disconnected");
    assert.equal(retainedConnection.rows[0].access_token_ciphertext, null);
  });
});
