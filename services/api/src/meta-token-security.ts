import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function keyFromEnvironment() {
  const encoded = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("WhatsApp credential encryption is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("WhatsApp credential encryption configuration is invalid.");
  }
  return key;
}

export function hasMetaTokenEncryptionKey() {
  try {
    keyFromEnvironment();
    return true;
  } catch {
    return false;
  }
}

export function encryptMetaAccessToken(token: string) {
  if (!token || token.length > 10000) throw new Error("Meta access token is invalid.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromEnvironment(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64")
  });
}

export function decryptMetaAccessToken(encrypted: string) {
  const value = JSON.parse(encrypted) as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
  if (value.v !== 1 || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.data !== "string") {
    throw new Error("WhatsApp credential ciphertext is invalid.");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFromEnvironment(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const token = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
  if (!token || token.length > 10000) throw new Error("WhatsApp credential ciphertext is invalid.");
  return token;
}
