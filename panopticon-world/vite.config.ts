import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone design prototype — no backend, no proxy. Mocks only.
export default defineConfig({
  plugins: [react()],
  server: { port: 5273, open: true },
});
