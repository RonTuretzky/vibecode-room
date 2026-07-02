import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { corsEnabledWarning, corsOrigins, vibersynCors } from "./cors";

describe("corsEnabledWarning", () => {
  test("warns only for the wildcard (unauthenticated mutating API)", () => {
    expect(corsEnabledWarning({})).toBeNull();
    expect(corsEnabledWarning({ VIBERSYN_CORS_ORIGIN: "http://localhost:8000" })).toBeNull();
    expect(corsEnabledWarning({ VIBERSYN_CORS_ORIGIN: "*" })).toContain("ANY origin");
  });
});

describe("corsOrigins", () => {
  test("null when unset/empty (CORS off by default)", () => {
    expect(corsOrigins({})).toBeNull();
    expect(corsOrigins({ VIBERSYN_CORS_ORIGIN: "  " })).toBeNull();
  });
  test("wildcard, single, and comma-separated list", () => {
    expect(corsOrigins({ VIBERSYN_CORS_ORIGIN: "*" })).toBe("*");
    expect(corsOrigins({ VIBERSYN_CORS_ORIGIN: "http://localhost:8000" })).toEqual(["http://localhost:8000"]);
    expect(corsOrigins({ VIBERSYN_CORS_ORIGIN: "http://a:8000, http://b:8000" })).toEqual(["http://a:8000", "http://b:8000"]);
  });
});

// Build a Hono app with the middleware mounted and exercise it via app.request()
// (no server/port needed).
function appWith(env: Record<string, string | undefined>): Hono {
  const app = new Hono();
  const mw = vibersynCors(env);
  if (mw !== null) {
    app.use("/api/*", mw);
  }
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/capture", (c) => c.json({ captureMode: true }));
  return app;
}

describe("vibersynCors middleware", () => {
  test("disabled → no Access-Control-Allow-Origin header", async () => {
    const res = await appWith({}).request("/api/health", { headers: { origin: "http://localhost:8000" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.status).toBe(200);
  });

  test("wildcard → echoes allow-origin for a GET", async () => {
    const res = await appWith({ VIBERSYN_CORS_ORIGIN: "*" }).request("/api/health", { headers: { origin: "http://localhost:8000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("allowlisted origin → preflight OPTIONS on POST /api/capture succeeds", async () => {
    const app = appWith({ VIBERSYN_CORS_ORIGIN: "http://localhost:8000" });
    const preflight = await app.request("/api/capture", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:8000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:8000");
    expect(preflight.headers.get("access-control-allow-methods") ?? "").toContain("POST");
  });

  test("non-allowlisted origin is not granted access", async () => {
    const res = await appWith({ VIBERSYN_CORS_ORIGIN: "http://localhost:8000" }).request("/api/health", {
      headers: { origin: "http://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
  });
});
