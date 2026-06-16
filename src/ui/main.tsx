import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectorApp } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element for Panopticon projector app.");
}

createRoot(root).render(
  <StrictMode>
    <ProjectorApp />
  </StrictMode>,
);
