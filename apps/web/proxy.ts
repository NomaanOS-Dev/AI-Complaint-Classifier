import { NextResponse, type NextRequest } from "next/server";
import { contactFrameAncestors } from "./lib/contact-frame-policy";

const apiBase = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function proxy(request: NextRequest) {
  const token = request.nextUrl.pathname.split("/")[2] ?? "";
  let ancestors = contactFrameAncestors(false, []);
  try {
    const response = await fetch(`${apiBase}/public/contact/${encodeURIComponent(token)}`, {
      cache: "no-store", signal: AbortSignal.timeout(2500)
    });
    if (response.ok) {
      const payload = await response.json() as { form?: { active?: boolean; allowedOrigins?: unknown } };
      ancestors = contactFrameAncestors(Boolean(payload.form?.active), payload.form?.allowedOrigins);
    }
  } catch { /* Fail closed for framing when the public form configuration cannot be verified. */ }
  const result = NextResponse.next();
  result.headers.set("Content-Security-Policy", `frame-ancestors ${ancestors}`);
  return result;
}

export const config = { matcher: ["/contact/:token"] };
