import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./types";
import { auth } from "./auth";
import { proxy } from "./proxy";
import { billing } from "./billing";

const app = new Hono<AppEnv>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

app.get("/health", (c) => c.text("ok"));
app.route("/auth", auth);
app.route("/", proxy);
app.route("/billing", billing);

export default app;
