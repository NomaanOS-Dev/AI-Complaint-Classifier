import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createWhatsAppGraphApi, WhatsAppProviderError } from "../src/meta-whatsapp.js";
import { decryptMetaAccessToken, encryptMetaAccessToken, hasMetaTokenEncryptionKey } from "../src/meta-token-security.js";

const originalKey = process.env.META_TOKEN_ENCRYPTION_KEY;
const savedGraphVersion = process.env.META_GRAPH_API_VERSION;
after(() => {
  if (originalKey === undefined) delete process.env.META_TOKEN_ENCRYPTION_KEY;
  else process.env.META_TOKEN_ENCRYPTION_KEY = originalKey;
  if (savedGraphVersion === undefined) delete process.env.META_GRAPH_API_VERSION;
  else process.env.META_GRAPH_API_VERSION = savedGraphVersion;
});

describe("WhatsApp Embedded Signup provider helpers", () => {
  test("access tokens are authenticated-encrypted and fail closed on missing, invalid, or tampered keys/data", () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
    const token = "fixture-access-token-must-not-be-plaintext";
    const encrypted = encryptMetaAccessToken(token);
    assert.doesNotMatch(encrypted, /fixture-access-token/);
    assert.equal(JSON.parse(encrypted).v, 1);
    assert.equal(decryptMetaAccessToken(encrypted), token);
    const envelope = JSON.parse(encrypted) as { data: string };
    envelope.data = Buffer.from("tampered").toString("base64");
    assert.throws(() => decryptMetaAccessToken(JSON.stringify(envelope)));

    delete process.env.META_TOKEN_ENCRYPTION_KEY;
    assert.equal(hasMetaTokenEncryptionKey(), false);
    assert.throws(() => encryptMetaAccessToken(token), /encryption is not configured/);
    process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    assert.equal(hasMetaTokenEncryptionKey(), false);
  });

  test("Graph API client exchanges, validates, matches account assets, and subscribes without logging secrets", async () => {
    process.env.META_GRAPH_API_VERSION = "v26.0";
    const requests: Array<{ url: URL; method: string; authorization: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? "GET";
      requests.push({ url, method, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname.endsWith("/oauth/access_token")) {
        assert.equal(url.searchParams.get("client_id"), "fixture-app-id");
        assert.equal(url.searchParams.get("client_secret"), "fixture-app-secret");
        assert.equal(url.searchParams.get("code"), "one-time-code");
        return Response.json({ access_token: "fixture-business-token", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/debug_token")) {
        assert.equal(url.searchParams.get("input_token"), "fixture-business-token");
        assert.equal(url.searchParams.get("access_token"), "fixture-app-id|fixture-app-secret");
        return Response.json({ data: {
          app_id: "fixture-app-id",
          is_valid: true,
          scopes: ["whatsapp_business_management", "whatsapp_business_messaging"]
        } });
      }
      if (url.pathname.endsWith("/123456789012345")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-business-token");
        return Response.json({ id: "123456789012345", display_phone_number: "+1 555 0100" });
      }
      if (url.pathname.endsWith("/987654321098765/phone_numbers")) {
        return Response.json({ data: [
          { id: "111111111111111", display_phone_number: "+1 555 0101" },
          { id: "123456789012345", display_phone_number: "+1 555 0100", verified_name: "Example Business" }
        ] });
      }
      if (url.pathname.endsWith("/987654321098765/subscribed_apps")) return Response.json({ success: true });
      return Response.json({ error: { message: "sensitive provider response not to be exposed" } }, { status: 400 });
    };
    const graph = createWhatsAppGraphApi(fakeFetch, {
      appId: "fixture-app-id",
      appSecret: "fixture-app-secret",
      loginConfigId: "fixture-login-config",
      graphVersion: "v26.0"
    });
    const token = await graph.exchangeCode("one-time-code");
    assert.equal(token.accessToken, "fixture-business-token");
    assert.ok(token.expiresAt instanceof Date);
    await graph.validateToken(token.accessToken);
    const phone = await graph.validateAssets(token.accessToken, {
      phoneNumberId: "123456789012345",
      wabaId: "987654321098765"
    });
    assert.deepEqual(phone, {
      id: "123456789012345",
      displayPhoneNumber: "+1 555 0100",
      verifiedName: "Example Business"
    });
    await graph.subscribe(token.accessToken, "987654321098765");
    assert.equal(requests[0].url.protocol, "https:");
    assert.ok(requests.every((request) => request.url.hostname === "graph.facebook.com"));
    assert.ok(requests.some((request) => request.authorization === "Bearer fixture-business-token"));
  });

  test("Graph API client rejects invalid access grants and mismatched phone/WABA assets", async () => {
    const tokenGraph = createWhatsAppGraphApi(async () =>
      Response.json({ data: { app_id: "another-app", is_valid: true, scopes: [] } }),
    { appId: "fixture-app-id", appSecret: "fixture-app-secret", loginConfigId: "fixture-config", graphVersion: "v26.0" });
    await assert.rejects(tokenGraph.validateToken("opaque-token"), (error: unknown) =>
      error instanceof WhatsAppProviderError && error.code === "provider_token_invalid");

    let requestNumber = 0;
    const mismatchGraph = createWhatsAppGraphApi(async () => {
      requestNumber += 1;
      if (requestNumber === 1) return Response.json({ id: "123456789012345" });
      return Response.json({ data: [{ id: "different-phone" }] });
    }, { appId: "fixture-app-id", appSecret: "fixture-app-secret", loginConfigId: "fixture-config", graphVersion: "v26.0" });
    await assert.rejects(mismatchGraph.validateAssets("opaque-token", {
      phoneNumberId: "123456789012345",
      wabaId: "987654321098765"
    }), (error: unknown) => error instanceof WhatsAppProviderError && error.code === "provider_asset_mismatch");
  });
});
