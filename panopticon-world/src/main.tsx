import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import { engine } from "./world/mockEngine.ts";
import "./styles.css";

// Test/debug hook: e2e specs read world state via window.__world.
(window as unknown as { __world: typeof engine }).__world = engine;

// Surface async / render-loop errors (which React error boundaries can't catch)
// directly on screen instead of letting the canvas blank out.
function showGlobalError(msg: string) {
  let el = document.getElementById("global-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "global-error";
    el.className = "crash";
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="crash-box snes-panel"><h2>⚠ runtime error</h2><pre>${msg.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
  )}</pre><p>Check the browser console for the full stack.</p></div>`;
}
window.addEventListener("error", (e) => showGlobalError(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => showGlobalError(String(e.reason)));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
