import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

// CORS for the Vibersyn API. OFF by default (same-origin only). Set
// VIBERSYN_CORS_ORIGIN to enable cross-origin access — this is how the gesture-wall
// web client (served on its own origin/port) is allowed to drive Vibersyn via
// POST /api/capture, /api/suggestion/accept, /api/emergency-stop, etc.
//
//   VIBERSYN_CORS_ORIGIN="*"                          → allow any origin (DEMO ONLY)
//   VIBERSYN_CORS_ORIGIN="http://localhost:8000"      → allow one origin (recommended)
//   VIBERSYN_CORS_ORIGIN="http://a:8000,http://b:8000" → allow a list
//
// SECURITY: the /api mutating routes (POST /api/capture, /api/suggestion/accept,
// /api/emergency-stop, ...) are UNAUTHENTICATED. Setting "*" lets ANY web page a
// browser visits drive them cross-origin. In a real deployment set an explicit
// origin (the gesture-wall host), never "*". `corsEnabledWarning` surfaces this.
export interface CorsEnv {
  VIBERSYN_CORS_ORIGIN?: string;
  [key: string]: string | undefined;
}

export function corsOrigins(env: CorsEnv): string | string[] | null {
  const raw = env.VIBERSYN_CORS_ORIGIN?.trim();
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw === "*") {
    return "*";
  }
  const list = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return list.length > 0 ? list : null;
}

// A warning string when the configured CORS policy is dangerously permissive
// (wildcard) for the unauthenticated mutating API, else null. Logged at boot.
export function corsEnabledWarning(env: CorsEnv): string | null {
  return corsOrigins(env) === "*"
    ? "VIBERSYN_CORS_ORIGIN='*' allows ANY origin to drive the unauthenticated /api mutating routes (capture, accept, emergency-stop). Use an explicit origin in production."
    : null;
}

// Returns the CORS middleware to mount on /api/*, or null when CORS is disabled.
export function vibersynCors(env: CorsEnv): MiddlewareHandler | null {
  const origin = corsOrigins(env);
  if (origin === null) {
    return null;
  }
  return cors({
    origin,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type"],
    maxAge: 600,
  });
}
