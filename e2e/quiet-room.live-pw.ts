import { expect, test } from "./live-room";

test("an idle room keeps its event stream open beyond Bun's default timeout", async ({ wall }) => {
  let connections = 0;
  wall.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/events") connections += 1;
  });
  await wall.open("/?wall=A&remote=0");
  await expect.poll(() => connections).toBeGreaterThan(0);
  const initialConnections = connections;
  await wall.page.waitForTimeout(14_000);
  expect(connections, "a quiet stream must not disconnect and reconnect every ten seconds").toBe(initialConnections);
});
