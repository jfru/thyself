import { Hono } from "hono";
import type { AppEnv, UserRow } from "./types";
import { createJwt, authMiddleware } from "./middleware";

const auth = new Hono<AppEnv>();

function generateCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1000000).padStart(6, "0");
}

function generateId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

auth.post("/send-code", async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "Valid email required" }, 400);
  }

  // Invalidate previous unused codes for this email
  await c.env.DB.prepare(
    "UPDATE auth_codes SET used = 1 WHERE email = ? AND used = 0"
  ).bind(email).run();

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    "INSERT INTO auth_codes (email, code, expires_at) VALUES (?, ?, ?)"
  ).bind(email, code, expiresAt).run();

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Thyself <auth@thyself.fyi>",
      to: [email],
      subject: `${code} is your Thyself verification code`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #e4e4e7; margin-bottom: 8px;">Your verification code</h2>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #ffffff; background: #18181b; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
            ${code}
          </div>
          <p style="color: #a1a1aa; font-size: 14px;">Enter this code in the Thyself app to sign in. It expires in 10 minutes.</p>
          <p style="color: #71717a; font-size: 12px; margin-top: 30px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    console.error("Resend error:", await res.text());
    return c.json({ error: "Failed to send code" }, 500);
  }

  return c.json({ sent: true });
});

auth.post("/verify", async (c) => {
  const body = await c.req.json<{ email?: string; code?: string }>();
  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();

  if (!email || !code) {
    return c.json({ error: "Email and code required" }, 400);
  }

  const row = await c.env.DB.prepare(
    "SELECT id, expires_at FROM auth_codes WHERE email = ? AND code = ? AND used = 0 ORDER BY id DESC LIMIT 1"
  ).bind(email, code).first<{ id: number; expires_at: string }>();

  if (!row) {
    return c.json({ error: "Invalid code" }, 401);
  }

  if (new Date(row.expires_at) < new Date()) {
    return c.json({ error: "Code expired" }, 401);
  }

  await c.env.DB.prepare(
    "UPDATE auth_codes SET used = 1 WHERE id = ?"
  ).bind(row.id).run();

  let user = await c.env.DB.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).bind(email).first<UserRow>();

  if (!user) {
    const id = generateId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, subscription_status, created_at) VALUES (?, ?, 'none', ?)"
    ).bind(id, email, now).run();
    user = { id, email, stripe_customer_id: null, subscription_status: "none", subscription_period_end: null, created_at: now };
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: user.id, email: user.email, iat: now, exp: now + 30 * 24 * 60 * 60 },
    c.env.JWT_SECRET
  );

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      subscription_status: user.subscription_status,
    },
  });
});

auth.get("/me", authMiddleware, async (c) => {
  const user = c.get("user") as UserRow;
  return c.json({
    id: user.id,
    email: user.email,
    subscription_status: user.subscription_status,
    subscription_period_end: user.subscription_period_end,
  });
});

export { auth };
