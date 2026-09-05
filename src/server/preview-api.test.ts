import { expect, test } from "bun:test";
import { servePreviewDirectory } from "./idea-builder";

test("preview actions reach their own resolved room address, including method and payload", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    return Response.json({ path: new URL(req.url).pathname, method: req.method, body: await req.text() });
  } });
  const preview = await servePreviewDirectory(process.cwd(), "127.0.0.1", `http://127.0.0.1:${upstream.port}`, { upid: "example", ideaId: "idea-one" });
  try {
    const response = await fetch(`http://127.0.0.1:${preview.port}/api/process/example/answer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"answer":"yes"}',
    });
    for (const path of ["/api/emergency-stop", "/api/process/other/answer", "/api/process/example/halt", "/api/projects/import", "/api/idea/other/dismiss"]) {
      expect((await fetch(`http://127.0.0.1:${preview.port}${path}`, { method: "POST" })).status).toBe(403);
    }
    expect(await response.json()).toEqual({ path: "/api/process/example/answer", method: "POST", body: '{"answer":"yes"}' });
  } finally {
    await preview.stop();
    upstream.stop(true);
  }
});
