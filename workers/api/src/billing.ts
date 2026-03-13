import { Hono } from "hono";
import type { AppEnv, UserRow } from "./types";
import { authMiddleware } from "./middleware";
import Stripe from "stripe";

const billing = new Hono<AppEnv>();

billing.post("/checkout", authMiddleware, async (c) => {
  const user = c.get("user") as UserRow;
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { thyself_user_id: user.id },
    });
    customerId = customer.id;
    await c.env.DB.prepare(
      "UPDATE users SET stripe_customer_id = ? WHERE id = ?"
    ).bind(customerId, user.id).run();
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [
      { price: c.env.STRIPE_BASE_PRICE_ID, quantity: 1 },
      { price: c.env.STRIPE_METERED_PRICE_ID },
    ],
    success_url: "https://thyself.fyi/billing/success",
    cancel_url: "https://thyself.fyi/billing/cancel",
  });

  return c.json({ url: session.url });
});

billing.post("/portal", authMiddleware, async (c) => {
  const user = c.get("user") as UserRow;
  if (!user.stripe_customer_id) {
    return c.json({ error: "No billing account" }, 400);
  }

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: "https://thyself.fyi",
  });

  return c.json({ url: session.url });
});

billing.post("/webhook", async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 400);
  }

  const rawBody = await c.req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.customer && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(
          session.subscription as string
        );
        await c.env.DB.prepare(
          "UPDATE users SET subscription_status = ?, subscription_period_end = ? WHERE stripe_customer_id = ?"
        )
          .bind(
            sub.status === "active" ? "active" : sub.status,
            new Date((sub as any).current_period_end * 1000).toISOString(),
            session.customer as string
          )
          .run();
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await c.env.DB.prepare(
        "UPDATE users SET subscription_status = ?, subscription_period_end = ? WHERE stripe_customer_id = ?"
      )
        .bind(
          sub.status === "active" ? "active" : sub.status,
          new Date((sub as any).current_period_end * 1000).toISOString(),
          sub.customer as string
        )
        .run();
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await c.env.DB.prepare(
        "UPDATE users SET subscription_status = 'cancelled' WHERE stripe_customer_id = ?"
      )
        .bind(sub.customer as string)
        .run();
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.customer) {
        await c.env.DB.prepare(
          "UPDATE users SET subscription_status = 'past_due' WHERE stripe_customer_id = ?"
        )
          .bind(invoice.customer as string)
          .run();
      }
      break;
    }
  }

  return c.json({ received: true });
});

export { billing };
