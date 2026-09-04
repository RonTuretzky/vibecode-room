import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { roomApiOrigin } from "./src/config/network";

export default defineConfig(({ mode }) => {
  const target = roomApiOrigin({ ...loadEnv(mode, process.cwd(), ""), ...process.env });
  const proxy = Object.fromEntries(["/api", "/hands", "/submit", "/salem"].map((path) =>
    [path, { target, ws: true, changeOrigin: true }]));
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1", port: 5173, proxy,
      // Builds and browser-test reports contain HTML; writing them must not
      // reload the operator's wall and discard its open recording/deck UI.
      watch: { ignored: ["**/builds/**", "**/artifacts/**", "**/test-results*/**", "**/playwright-report/**"] },
    },
    preview: { host: "127.0.0.1", port: 4173, proxy },
  };
});
