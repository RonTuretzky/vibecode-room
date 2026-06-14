// Drives the running server through a scripted "room conversation" so you can
// watch bubbles appear and processes spawn without talking. Run the server
// first (`bun start`), then in another shell: `bun run seed`.

const BASE = process.env.BASE ?? "http://localhost:7777";

const lines = [
  "morning — what are we building today",
  "I keep losing track of all the agent processes we have running, we should build a dashboard to track them",
  "yeah and what if it visualized each one differently depending on what it is",
  "honestly we could also make a little tool to turn the whiteboard photos into a spec",
  "ooh and an art generator that matches the vibe of the room",
];

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

for (const text of lines) {
  console.log("room:", text);
  await post("/api/transcript", { text, source: "seed" });
  await new Promise((r) => setTimeout(r, 1800));
}
console.log("\nseed done — open http://localhost:7777 and watch the bubbles.");
