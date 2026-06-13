import { defineConfig } from "@playwright/test";

// E2E config. Reuses the running dev server if present, else starts one.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5273",
    headless: true,
    // SwiftShader software WebGL so the scene runs in CI/headless without a GPU.
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
  },
  webServer: {
    command: "bun run dev",
    port: 5273,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
