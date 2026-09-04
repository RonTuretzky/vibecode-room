import { expect, test } from "bun:test";
import { servePreviewDirectory } from "./idea-builder";

test("preview actions reach their own resolved room address, including method and payload", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    return Response.json({ path: new URL(req.url).pathname, method: req.method, body: await req.text() });
  } });
  const preview = await servePreviewDirectory(process.cwd(), "127.0.0.1", `http://127.0.0.1:${upstream.port}`);
  try {
    const response = await fetch(`http://127.0.0.1:${preview.port}/api/process/example/answer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"answer":"yes"}',
    });
    expect(await response.json()).toEqual({ path: "/api/process/example/answer", method: "POST", body: '{"answer":"yes"}' });
  } finally {
    await preview.stop();
    upstream.stop(true);
  }
});
