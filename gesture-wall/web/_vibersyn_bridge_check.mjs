// Node check for web/vibersyn-bridge.js pure logic (no DOM, no network).
// Run: node web/_vibersyn_bridge_check.mjs
import assert from "node:assert/strict";
import { parseZoneMap, createBridge } from "./vibersyn-bridge.js";

let n = 0;
const ok = (name) => { n++; console.log(`  ok ${name}`); };

// --- parseZoneMap ----------------------------------------------------------
{
  const d = parseZoneMap("");
  assert.equal(d.r0c0, "capture", "default: capture tile");
  assert.equal(d.r1c2, "emergency", "default: emergency tile");

  const c = parseZoneMap("r0c0:emergency,r0c1:capture,r0c2:bogus");
  assert.equal(c.r0c0, "emergency", "override respected");
  assert.equal(c.r0c1, "capture");
  assert.equal(c.r0c2, undefined, "unknown action ignored");

  // A spec with no valid pairs falls back to the default map.
  assert.equal(parseZoneMap("nope:nope").r0c0, "capture", "invalid spec -> default");
  ok("parseZoneMap");
}

// --- disabled bridge (no ?vibersyn) ---------------------------------------
{
  const b = createBridge("?wall=A");
  assert.equal(b.enabled, false, "no ?vibersyn -> disabled");
  assert.equal(b.resolve({ zoneId: "r0c0", selected: true }), null, "disabled -> no plan");
  ok("disabled bridge no-ops");
}

// --- enabled bridge resolve: toggle vs oneshot ----------------------------
{
  const b = createBridge("?vibersyn=http://localhost:8788/");
  assert.equal(b.enabled, true);
  assert.equal(b.base, "http://localhost:8788", "trailing slash trimmed");

  // Toggle tiles send { on } on both edges.
  assert.deepEqual(b.resolve({ zoneId: "r0c0", selected: true }), { endpoint: "/api/capture", body: { on: true }, actionName: "capture" });
  assert.deepEqual(b.resolve({ zoneId: "r0c0", selected: false }).body, { on: false }, "toggle sends off too");

  // Oneshot tiles fire only on the select edge.
  assert.equal(b.resolve({ zoneId: "r1c2", selected: false }), null, "oneshot ignores deselect");
  assert.deepEqual(b.resolve({ zoneId: "r1c2", selected: true }), { endpoint: "/api/emergency-stop", body: undefined, actionName: "emergency" });

  // Unmapped zone -> null.
  assert.equal(b.resolve({ zoneId: "r1c1", selected: true }), null, "unmapped zone -> null");
  ok("resolve toggle vs oneshot");
}

// --- onDwell POSTs via an injected fetch ----------------------------------
{
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const b = createBridge("?vibersyn=http://host:8788", fakeFetch);

  await b.onDwell({ zoneId: "r0c1", selected: true });   // accept (oneshot)
  assert.equal(calls.length, 1, "mapped select -> one POST");
  assert.equal(calls[0].url, "http://host:8788/api/suggestion/accept");
  assert.equal(calls[0].init.method, "POST");

  await b.onDwell({ zoneId: "r1c1", selected: true });   // unmapped -> no POST
  assert.equal(calls.length, 1, "unmapped zone does not POST");

  await b.onDwell({ zoneId: "r1c2", selected: false });  // oneshot deselect -> no POST
  assert.equal(calls.length, 1, "oneshot deselect does not POST");
  ok("onDwell posts mapped actions only");
}

console.log(`\nvibersyn-bridge node check: ${n} groups passed`);
