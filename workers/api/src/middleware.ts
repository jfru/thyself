import type { Context, Next } from "hono";
import type { AppEnv, JwtPayload, UserRow } from "./types";

const encoder = new TextEncoder();

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createJwt(
  payload: JwtPayload,
  secret: string
): Promise<string> {
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  );
  const body = base64UrlEncode(
    encoder.encode(JSON.stringify(payload))
  );
  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${header}.${body}`)
  );
  return `${header}.${body}.${base64UrlEncode(signature)}`;
}

export async function verifyJwt(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const key = await getSigningKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(parts[1]))
  ) as JwtPayload;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

export async function authMiddleware(
  c: Context<AppEnv>,
  next: Next
) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE id = ?"
  )
    .bind(payload.sub)
    .first<UserRow>();

  if (!user) {
    return c.json({ error: "User not found" }, 401);
  }

  c.set("user", user);
  c.set("jwtPayload", payload);
  await next();
}

export async function subscriptionMiddleware(
  c: Context<AppEnv>,
  next: Next
) {
  const user = c.get("user") as UserRow;
  if (user.subscription_status !== "active") {
    return c.json(
      { error: "Active subscription required", subscription_status: user.subscription_status },
      403
    );
  }
  await next();
}
