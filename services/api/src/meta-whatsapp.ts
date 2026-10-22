import { createHash, randomBytes } from "node:crypto";
import type { Application, RequestHandler } from "express";
import { pool } from "./db.js";
import { decryptMetaAccessToken, encryptMetaAccessToken, hasMetaTokenEncryptionKey } from "./meta-token-security.js";

const onboardingStateLifetimeMs = 10 * 60 * 1000;
const providerTimeoutMs = 10000;
const expectedPermissions = ["whatsapp_business_management", "whatsapp_business_messaging"];

type JsonObject = Record<string, unknown>;
type GraphResponse = JsonObject;
type SignupAssets = { phoneNumberId: string; wabaId: string };
type ConnectedPhone = { id: string; displayPhoneNumber: string | null; verifiedName: string | null };

export type WhatsAppGraphApi = {
  exchangeCode: (code: string) => Promise<{ accessToken: string; expiresAt: Date | null }>;
  validateToken: (accessToken: string) => Promise<void>;
  validateAssets: (accessToken: string, assets: SignupAssets) => Promise<ConnectedPhone>;
  subscribe: (accessToken: string, wabaId: string) => Promise<void>;
  unsubscribe: (accessToken: string, wabaId: string) => Promise<void>;
};

type RouteOptions = {
  requireAuth: RequestHandler;
  csrfProtection: RequestHandler;
  requireWorkspaceRole: (roles: Array<"owner" | "admin" | "member">) => RequestHandler;
  graphApi?: WhatsAppGraphApi;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numericMetaId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,32}$/.test(value);
}

function configuration(graphVersion = process.env.META_GRAPH_API_VERSION ?? "v26.0") {
  return {
    appId: process.env.META_APP_ID?.trim() ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    loginConfigId: process.env.META_LOGIN_CONFIG_ID?.trim() ?? "",
    graphVersion
  };
}

export function whatsappSetupStatus() {
  const config = configuration();
  const apiBase = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const webOrigin = process.env.WEB_ORIGIN?.trim() ?? "";
  const missing: string[] = [];
  if (!config.appId) missing.push("META_APP_ID");
  if (!config.loginConfigId) missing.push("META_LOGIN_CONFIG_ID");
  if (!config.appSecret) missing.push("META_APP_SECRET");
  if (!process.env.META_WEBHOOK_VERIFY_TOKEN) missing.push("META_WEBHOOK_VERIFY_TOKEN");
  if (!hasMetaTokenEncryptionKey()) missing.push("META_TOKEN_ENCRYPTION_KEY");
  if (!apiBase || !apiBase.startsWith("https://")) missing.push("PUBLIC_API_BASE_URL must be a public HTTPS API URL");
  if (!webOrigin || !webOrigin.startsWith("https://")) missing.push("WEB_ORIGIN must be the public HTTPS web origin");
  if (!/^v\d+\.\d+$/.test(config.graphVersion)) missing.push("META_GRAPH_API_VERSION must use the vNN.N format");
  return {
    ready: missing.length === 0,
    missing,
    appId: config.appId || null,
    loginConfigId: config.loginConfigId || null,
    graphApiVersion: config.graphVersion,
    callbackUrl: apiBase.startsWith("https://") ? `${apiBase}/webhooks/meta` : null
  };
}

export class WhatsAppProviderError extends Error {
  constructor(readonly code: string) {
    super("WhatsApp provider request failed.");
    this.name = "WhatsAppProviderError";
  }
}

function readGraphObject(value: unknown): GraphResponse {
  if (!isObject(value) || isObject(value.error)) throw new WhatsAppProviderError("provider_rejected_request");
  return value;
}

export function createWhatsAppGraphApi(
  fetcher: typeof fetch = fetch,
  suppliedConfig = configuration()
): WhatsAppGraphApi {
  const apiRoot = `https://graph.facebook.com/${suppliedConfig.graphVersion}`;
  const timeoutFetch = async (url: URL, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(providerTimeoutMs) });
    } catch {
      throw new WhatsAppProviderError("provider_unavailable");
    }
    if (!response.ok) throw new WhatsAppProviderError("provider_rejected_request");
    let parsed: unknown;
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("Response too large");
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new WhatsAppProviderError("provider_invalid_response");
    }
    return readGraphObject(parsed);
  };
  const graphGet = async (path: string, token: string, params: Record<string, string> = {}) => {
    const url = new URL(`${apiRoot}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return timeoutFetch(url, { headers: { authorization: `Bearer ${token}` } });
  };
  const graphPost = async (path: string, token: string) =>
    timeoutFetch(new URL(`${apiRoot}/${path}`), { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const graphDelete = async (path: string, token: string) =>
    timeoutFetch(new URL(`${apiRoot}/${path}`), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });

  return {
    async exchangeCode(code) {
      const url = new URL(`${apiRoot}/oauth/access_token`);
      url.searchParams.set("client_id", suppliedConfig.appId);
      url.searchParams.set("client_secret", suppliedConfig.appSecret);
      url.searchParams.set("code", code);
      const result = await timeoutFetch(url);
      if (typeof result.access_token !== "string" || !result.access_token || result.access_token.length > 10000) {
        throw new WhatsAppProviderError("provider_invalid_response");
      }
      const expiry = typeof result.expires_in === "number" && Number.isFinite(result.expires_in) && result.expires_in > 0
        ? new Date(Date.now() + result.expires_in * 1000) : null;
      return { accessToken: result.access_token, expiresAt: expiry };
    },
    async validateToken(accessToken) {
      const appAccessToken = `${suppliedConfig.appId}|${suppliedConfig.appSecret}`;
      const debugUrl = new URL(`${apiRoot}/debug_token`);
      debugUrl.searchParams.set("input_token", accessToken);
      debugUrl.searchParams.set("access_token", appAccessToken);
      const result = await timeoutFetch(debugUrl);
      const data = result.data;
      const scopes = isObject(data) && Array.isArray(data.scopes) &&
        data.scopes.every((scope): scope is string => typeof scope === "string") ? data.scopes : [];
      if (!isObject(data) || data.is_valid !== true || data.app_id !== suppliedConfig.appId ||
          !expectedPermissions.every((scope) => scopes.includes(scope))) {
        throw new WhatsAppProviderError("provider_token_invalid");
      }
    },
    async validateAssets(accessToken, assets) {
      const phoneUrl = new URL(`${apiRoot}/${assets.phoneNumberId}`);
      phoneUrl.searchParams.set("fields", "id,display_phone_number,verified_name");
      const phoneResponse = await timeoutFetch(phoneUrl, { headers: { authorization: `Bearer ${accessToken}` } });
      if (phoneResponse.id !== assets.phoneNumberId) throw new WhatsAppProviderError("provider_asset_mismatch");

      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const params: Record<string, string> = { fields: "id,display_phone_number,verified_name", limit: "100" };
        if (after) params.after = after;
        const result = await graphGet(`${assets.wabaId}/phone_numbers`, accessToken, params);
        if (!Array.isArray(result.data)) throw new WhatsAppProviderError("provider_invalid_response");
        const matched = result.data.find((item) => isObject(item) && item.id === assets.phoneNumberId);
        if (matched && isObject(matched)) {
          return {
            id: assets.phoneNumberId,
            displayPhoneNumber: typeof matched.display_phone_number === "string" ? matched.display_phone_number.slice(0, 80) : null,
            verifiedName: typeof matched.verified_name === "string" ? matched.verified_name.trim().slice(0, 100) || null : null
          };
        }
        const paging = isObject(result.paging) ? result.paging : {};
        const cursors = isObject(paging.cursors) ? paging.cursors : {};
        after = typeof cursors.after === "string" && cursors.after.length <= 500 ? cursors.after : undefined;
        if (!after) break;
      }
      throw new WhatsAppProviderError("provider_asset_mismatch");
    },
    async subscribe(accessToken, wabaId) {
      const result = await graphPost(`${wabaId}/subscribed_apps`, accessToken);
      if (result.success !== true) throw new WhatsAppProviderError("webhook_subscription_failed");
    },
    async unsubscribe(accessToken, wabaId) {
      const result = await graphDelete(`${wabaId}/subscribed_apps`, accessToken);
      if (result.success !== true) throw new WhatsAppProviderError("webhook_unsubscribe_failed");
    }
  };
}

function dtoConnection(row: JsonObject) {
  return {
    id: row.id,
    provider: row.provider,
    provider_account_id: row.provider_account_id,
    business_account_id: row.business_account_id,
    display_name: row.display_name,
    status: row.status,
    connected_at: row.connected_at,
    access_token_expires_at: row.access_token_expires_at,
    phone_display_number: row.phone_display_number,
    phone_verified_name: row.phone_verified_name,
    authorized: Boolean(row.authorized)
  };
}

export function mountWhatsAppSignupRoutes(app: Application, options: RouteOptions) {
  const { requireAuth, csrfProtection, requireWorkspaceRole } = options;
  const graphApi = options.graphApi ?? createWhatsAppGraphApi();
  const role = requireWorkspaceRole(["owner", "admin"]);

  app.get("/workspaces/:workspaceId/integrations/whatsapp/config", requireAuth, role, (_req, res) => {
    const status = whatsappSetupStatus();
    res.json({
      ...status,
      setupInstructions: [
        "Create a Meta app with WhatsApp and Facebook Login for Business.",
        "Create an Embedded Signup v4 configuration for Cloud API.",
        "Enable messages and account_update webhooks and allow the public HTTPS NomaanOS web origin."
      ]
    });
  });

  app.post("/workspaces/:workspaceId/integrations/whatsapp/onboarding", csrfProtection, requireAuth, role, async (req, res) => {
    if (Object.keys(req.body ?? {}).length !== 0) {
      res.status(400).json({ error: "WhatsApp onboarding does not accept request fields." });
      return;
    }
    const setup = whatsappSetupStatus();
    if (!setup.ready) {
      res.status(503).json({ error: "WhatsApp Embedded Signup is not fully configured.", missing: setup.missing });
      return;
    }
    const user = res.locals.user as { id: string };
    const state = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO whatsapp_onboarding_states(state_hash, workspace_id, user_id, expires_at)
       VALUES($1, $2, $3, now() + interval '10 minutes')`,
      [createHash("sha256").update(state).digest(), String(req.params.workspaceId), user.id]
    );
    res.status(201).json({ state, expiresInSeconds: onboardingStateLifetimeMs / 1000 });
  });

  app.post("/workspaces/:workspaceId/integrations/whatsapp/complete", csrfProtection, requireAuth, role, async (req, res) => {
    const body = req.body;
    if (!isObject(body) || Object.keys(body).some((key) => !["state", "code", "phoneNumberId", "wabaId"].includes(key)) ||
        typeof body.state !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(body.state) ||
        typeof body.code !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(body.code) ||
        !numericMetaId(body.phoneNumberId) || !numericMetaId(body.wabaId)) {
      res.status(400).json({ error: "Meta returned an invalid WhatsApp onboarding result." });
      return;
    }
    const setup = whatsappSetupStatus();
    if (!setup.ready) {
      res.status(503).json({ error: "WhatsApp Embedded Signup is not fully configured.", missing: setup.missing });
      return;
    }
    const user = res.locals.user as { id: string };
    const client = await pool.connect();
    let consumed = false;
    try {
      await client.query("BEGIN");
      const stateResult = await client.query(
        `UPDATE whatsapp_onboarding_states SET consumed_at = now()
         WHERE state_hash = $1 AND workspace_id = $2 AND user_id = $3
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING id`,
        [createHash("sha256").update(body.state).digest(), String(req.params.workspaceId), user.id]
      );
      if (!stateResult.rowCount) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "WhatsApp onboarding has expired or was already used. Start again." });
        return;
      }
      await client.query("COMMIT");
      consumed = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!consumed) return;

    try {
      const { accessToken, expiresAt } = await graphApi.exchangeCode(body.code);
      await graphApi.validateToken(accessToken);
      const assets = { phoneNumberId: body.phoneNumberId, wabaId: body.wabaId };
      const phone = await graphApi.validateAssets(accessToken, assets);
      await graphApi.subscribe(accessToken, assets.wabaId);
      const tokenCiphertext = encryptMetaAccessToken(accessToken);
      const displayName = phone.verifiedName || phone.displayPhoneNumber || `WhatsApp ${phone.id}`;
      const result = await pool.query<JsonObject>(
        `INSERT INTO meta_social_connections
           (workspace_id, provider, provider_account_id, business_account_id, display_name, created_by, status,
            access_token_ciphertext, access_token_expires_at, connected_at, phone_display_number, phone_verified_name)
         VALUES($1, 'whatsapp', $2, $3, $4, $5, 'active', $6, $7, now(), $8, $9)
         ON CONFLICT(provider, provider_account_id) DO UPDATE SET
           business_account_id = EXCLUDED.business_account_id, display_name = EXCLUDED.display_name,
           created_by = EXCLUDED.created_by, status = 'active', access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           access_token_expires_at = EXCLUDED.access_token_expires_at, connected_at = now(),
           phone_display_number = EXCLUDED.phone_display_number, phone_verified_name = EXCLUDED.phone_verified_name,
           last_error_code = NULL, updated_at = now()
         WHERE meta_social_connections.workspace_id = EXCLUDED.workspace_id
         RETURNING id, provider, provider_account_id, business_account_id, display_name, status,
                   connected_at, access_token_expires_at, phone_display_number, phone_verified_name,
                   (access_token_ciphertext IS NOT NULL) AS authorized`,
        [String(req.params.workspaceId), phone.id, assets.wabaId, displayName, user.id, tokenCiphertext,
          expiresAt, phone.displayPhoneNumber, phone.verifiedName]
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: "This WhatsApp number is already connected to another workspace." });
        return;
      }
      res.status(201).json({ connection: dtoConnection(result.rows[0]) });
    } catch (error) {
      if (error instanceof WhatsAppProviderError) {
        res.status(error.code === "provider_asset_mismatch" || error.code === "provider_token_invalid" ? 400 : 502)
          .json({ error: "Meta could not verify the WhatsApp account. Start a new connection and try again.", code: error.code });
        return;
      }
      if (error instanceof Error && error.message.includes("credential encryption")) {
        res.status(503).json({ error: "WhatsApp credential encryption is unavailable. Contact your NomaanOS administrator." });
        return;
      }
      throw error;
    }
  });
}

export async function revokeWhatsAppSubscription(encryptedToken: string, wabaId: string, graphApi: WhatsAppGraphApi) {
  const accessToken = decryptMetaAccessToken(encryptedToken);
  await graphApi.unsubscribe(accessToken, wabaId);
}
