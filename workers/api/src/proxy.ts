import { Hono } from "hono";
import type { AppEnv, UserRow } from "./types";
import { authMiddleware, subscriptionMiddleware } from "./middleware";
import { calculateCostCents } from "./pricing";
import Stripe from "stripe";

const proxy = new Hono<AppEnv>();

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function extractUsageFromSSE(buffer: string): {
  usage: AnthropicUsage | null;
  model: string | null;
} {
  let usage: AnthropicUsage | null = null;
  let model: string | null = null;

  for (const line of buffer.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const event = JSON.parse(data);
      if (event.type === "message_start" && event.message) {
        model = event.message.model ?? null;
        if (event.message.usage) {
          usage = {
            input_tokens: event.message.usage.input_tokens ?? 0,
            output_tokens: event.message.usage.output_tokens ?? 0,
            cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
            cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
          };
        }
      }
      if (event.type === "message_delta" && event.usage) {
        usage = {
          input_tokens: (usage?.input_tokens ?? 0),
          output_tokens: (usage?.output_tokens ?? 0) + (event.usage.output_tokens ?? 0),
          cache_read_input_tokens: usage?.cache_read_input_tokens,
          cache_creation_input_tokens: usage?.cache_creation_input_tokens,
        };
      }
    } catch {
      // non-JSON event lines are expected
    }
  }

  return { usage, model };
}

proxy.post("/v1/messages", authMiddleware, subscriptionMiddleware, async (c) => {
  const user = c.get("user") as UserRow;
  const body = await c.req.text();

  let requestModel = "claude-sonnet-4-20250514";
  try {
    const parsed = JSON.parse(body);
    if (parsed.model) requestModel = parsed.model;
    // Force streaming on so we always get SSE with usage metadata
    parsed.stream = true;
    var requestBody = JSON.stringify(parsed);
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const forwardHeaders: Record<string, string> = {
    "x-api-key": c.env.ANTHROPIC_API_KEY,
    "content-type": "application/json",
  };
  for (const header of ["anthropic-version", "anthropic-beta"]) {
    const val = c.req.header(header);
    if (val) forwardHeaders[header] = val;
  }
  if (!forwardHeaders["anthropic-version"]) {
    forwardHeaders["anthropic-version"] = "2023-06-01";
  }

  const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: forwardHeaders,
    body: requestBody!,
  });

  if (!anthropicResponse.ok || !anthropicResponse.body) {
    const errorText = await anthropicResponse.text();
    return new Response(errorText, {
      status: anthropicResponse.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Stream response through while accumulating for usage extraction
  let sseBuffer = "";
  const reader = anthropicResponse.body.getReader();
  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const streamPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        await writer.write(value);
      }
    } finally {
      await writer.close();
    }
  })();

  // Record usage after stream completes (non-blocking)
  c.executionCtx.waitUntil(
    streamPromise.then(async () => {
      const { usage, model } = extractUsageFromSSE(sseBuffer);
      if (!usage) return;

      const resolvedModel = model ?? requestModel;
      const costCents = calculateCostCents(
        resolvedModel,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0
      );

      await c.env.DB.prepare(
        `INSERT INTO usage_records (user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          user.id,
          resolvedModel,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0,
          costCents,
          new Date().toISOString()
        )
        .run();

      if (user.stripe_customer_id && costCents > 0) {
        try {
          const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
          await stripe.billing.meterEvents.create({
            event_name: "anthropic_api_usage",
            payload: {
              value: String(Math.ceil(costCents)),
              stripe_customer_id: user.stripe_customer_id,
            },
          });
        } catch (err) {
          console.error("Stripe meter event error:", err);
        }
      }
    })
  );

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

export { proxy };
