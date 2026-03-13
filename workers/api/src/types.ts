export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  STRIPE_BASE_PRICE_ID: string;
  STRIPE_METERED_PRICE_ID: string;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

export interface UserRow {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_period_end: string | null;
  created_at: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    jwtPayload: JwtPayload;
  };
};
