// Development-only visual fixture. Vite serves this entry directly; the
// production build has only index.html. Every project action is in-memory.
import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectorApp } from "../src/ui/App";
import { busyRoomSnapshot } from "../src/ui/demo-data";
import "../src/ui/styles.css";

// App's transport gate reads the actual URL as well as its visual config.
// Redirect before mounting, so this fixture can never bind live project data.
const query = new URLSearchParams(location.search);
if (query.get("live") !== "0") {
  query.set("live", "0");
  location.replace(`${location.pathname}?${query}`);
} else {
  const requested = Number(query.get("trees") ?? 32);
  const count = Number.isFinite(requested) ? Math.max(1, Math.min(64, Math.floor(requested))) : 32;
  const snapshot = busyRoomSnapshot();
  const templates = snapshot.processes;
  snapshot.processes = Array.from({ length: count }, (_, i) => ({
    ...templates[i % templates.length]!,
    upid: `graphics-fixture-${i}`,
    runId: `graphics-run-${i}`,
    callsign: `Project ${i + 1}`,
    selected: false,
    previewUrl: undefined,
    source: undefined,
  }));
  createRoot(document.getElementById("root")!).render(
    <ProjectorApp initialSnapshot={snapshot} urlSearch="?live=0&env=park" />,
  );
}
