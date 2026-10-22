function safeOrigins(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    try {
      const parsed = new URL(item);
      const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
      return parsed.origin === item && (parsed.protocol === "https:" || localHttp) ? [parsed.origin] : [];
    } catch { return []; }
  });
}

export function contactFrameAncestors(active: boolean, allowedOrigins: unknown) {
  if (!active) return "'none'";
  return ["'self'", ...safeOrigins(allowedOrigins)].join(" ");
}
