#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS = resolve(ROOT, "artifacts/smithering");
const CAPTURES_DIR = resolve(ARTIFACTS, "ui-captures");
const TMP_ROOT = resolve(ARTIFACTS, ".capture-tmp");
const SLIDESHOW = resolve(ARTIFACTS, "gen-progress-slideshow.mjs");
const HOST = "127.0.0.1";
const VIEWPORT = { width: 1440, height: 1000 };
const LABEL = "[capture-app]";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
  ".cache",
]);

const UI_DEPENDENCIES = [
  "vite",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "next",
  "astro",
  "svelte",
  "@sveltejs/kit",
  "vue",
  "@vitejs/plugin-vue",
  "storybook",
  "@storybook/react",
  "@storybook/react-vite",
];

const STATE_PROBES = [
  {
    key: "idle",
    title: "idle-board",
    queries: ["?capture=idle", "?state=idle", "?demo=idle"],
  },
  {
    key: "suggestions",
    title: "idea-bubbles-suggestions",
    queries: ["?capture=suggestions", "?state=suggestions", "?demo=suggestions", "?capture=idea-bubbles"],
  },
  {
    key: "steering",
    title: "steering-banner",
    queries: ["?capture=steering", "?state=steering", "?demo=steering", "?capture=you-are-steering"],
  },
  {
    key: "garden",
    title: "living-process-garden",
    queries: ["?capture=garden", "?state=garden", "?demo=garden", "?capture=processes"],
  },
];

function log(message) {
  console.log(`${LABEL} ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function hasAnyDependency(pkg, names) {
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  return names.some((name) => Object.hasOwn(deps, name));
}

function packageManagerFor(dir) {
  if (existsSync(resolve(dir, "bun.lock")) || existsSync(resolve(dir, "bun.lockb"))) return "bun";
  if (existsSync(resolve(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(dir, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(ROOT, "bun.lock")) || existsSync(resolve(ROOT, "bun.lockb"))) return "bun";
  if (existsSync(resolve(ROOT, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(ROOT, "yarn.lock"))) return "yarn";
  return "npm";
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return result.status === 0;
}

function scriptLooksLikeUi(script) {
  return /\b(vite|next|astro|storybook|vite-preview|webpack-dev-server)\b/i.test(String(script || ""));
}

function hasBrowserEntry(dir) {
  const entries = [
    "index.html",
    "src/main.tsx",
    "src/main.jsx",
    "src/main.ts",
    "src/main.js",
    "src/App.tsx",
    "src/App.jsx",
    "app/page.tsx",
    "pages/index.tsx",
    "pages/index.jsx",
  ];
  return entries.some((entry) => existsSync(resolve(dir, entry)));
}

function hasViteConfig(dir) {
  return ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"].some((file) =>
    existsSync(resolve(dir, file)),
  );
}

function storyFilesMentionBoard(dir) {
  const stack = [dir];
  let scanned = 0;
  while (stack.length && scanned < 250) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      scanned += 1;
      if (!/\.stories\.(tsx|jsx|ts|js|mdx)$/i.test(entry.name)) continue;
      try {
        const text = readFileSync(full, "utf8");
        if (/vibersyn|display.?board|observability|trace|garden|steering/i.test(text)) return true;
      } catch {
        // Ignore unreadable story files.
      }
    }
  }
  return false;
}

function scorePackageCandidate(dir, pkg) {
  const scripts = pkg.scripts || {};
  let score = 0;
  const reasons = [];

  if (hasAnyDependency(pkg, UI_DEPENDENCIES)) {
    score += 4;
    reasons.push("UI dependencies");
  }
  if (hasViteConfig(dir)) {
    score += 5;
    reasons.push("Vite config");
  }
  if (hasBrowserEntry(dir)) {
    score += 4;
    reasons.push("browser entrypoint");
  }
  if (scriptLooksLikeUi(scripts.dev)) {
    score += 5;
    reasons.push("UI dev script");
  }
  if (scriptLooksLikeUi(scripts.preview)) {
    score += 3;
    reasons.push("UI preview script");
  }
  if (scriptLooksLikeUi(scripts.storybook) || storyFilesMentionBoard(dir)) {
    score += 3;
    reasons.push("storybook/display-board story");
  }
  if (/(^|\/)(web|app|apps|board|display|frontend)(\/|$)/i.test(relative(ROOT, dir))) {
    score += 1;
    reasons.push("frontend-looking path");
  }

  const serverOnlyDev = /\b(src\/server|server\/|bun\s+--watch|tsx\s+.*server|node\s+.*server)\b/i.test(
    String(scripts.dev || ""),
  );
  if (serverOnlyDev && !hasAnyDependency(pkg, UI_DEPENDENCIES) && !hasViteConfig(dir) && !hasBrowserEntry(dir)) {
    return { score: 0, reasons: ["server-only package"] };
  }

  return { score, reasons };
}

function walkForPackages(root, maxDepth = 4) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) found.push(dir);
    if (depth >= maxDepth) continue;

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (dir === ROOT && entry.name === ".smithers") continue;
      if (entry.name.startsWith(".") && entry.name !== ".smithers") continue;
      stack.push({ dir: resolve(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

function discoverUiCandidate() {
  const searchRoots = [ROOT];
  const integration = resolve(ROOT, ".smithers/integration");
  if (existsSync(integration)) searchRoots.push(integration);

  const packageDirs = [...new Set(searchRoots.flatMap((root) => walkForPackages(root)))];
  const candidates = [];

  for (const dir of packageDirs) {
    const pkg = readJson(resolve(dir, "package.json"));
    if (!pkg) continue;
    const { score, reasons } = scorePackageCandidate(dir, pkg);
    if (score < 6) continue;

    const scripts = pkg.scripts || {};
    const packageManager = packageManagerFor(dir);
    if (scripts.dev && scriptLooksLikeUi(scripts.dev)) {
      candidates.push({
        dir,
        packageManager,
        script: "dev",
        score: score + 2,
        reasons,
        urlPath: "/",
      });
      continue;
    }
    if (scripts.preview && scriptLooksLikeUi(scripts.preview)) {
      candidates.push({
        dir,
        packageManager,
        script: "preview",
        score,
        reasons,
        urlPath: "/",
      });
      continue;
    }
    if (scripts.storybook && scriptLooksLikeUi(scripts.storybook)) {
      candidates.push({
        dir,
        packageManager,
        script: "storybook",
        score: score - 1,
        reasons,
        urlPath: "/",
      });
      continue;
    }
    if (hasViteConfig(dir) || hasBrowserEntry(dir)) {
      candidates.push({
        dir,
        packageManager,
        execVite: true,
        score: score - 1,
        reasons,
        urlPath: "/",
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || relative(ROOT, a.dir).localeCompare(relative(ROOT, b.dir)));
  return candidates[0] || null;
}

function runArgsFor(candidate, port) {
  const viteArgs = ["--host", HOST, "--port", String(port), "--strictPort"];
  const env = {
    ...process.env,
    CI: "1",
    BROWSER: "none",
    HOST,
    PORT: String(port),
    VITE_PORT: String(port),
  };

  if (candidate.execVite) {
    if (candidate.packageManager === "bun") return { command: "bun", args: ["x", "vite", ".", ...viteArgs], env };
    if (candidate.packageManager === "pnpm") return { command: "pnpm", args: ["exec", "vite", ".", ...viteArgs], env };
    if (candidate.packageManager === "yarn") return { command: "yarn", args: ["vite", ".", ...viteArgs], env };
    return { command: "npm", args: ["exec", "--", "vite", ".", ...viteArgs], env };
  }

  if (candidate.packageManager === "bun") {
    return { command: "bun", args: ["run", candidate.script, "--", ...viteArgs], env };
  }
  if (candidate.packageManager === "pnpm") {
    return { command: "pnpm", args: ["run", candidate.script, "--", ...viteArgs], env };
  }
  if (candidate.packageManager === "yarn") {
    return { command: "yarn", args: [candidate.script, ...viteArgs], env };
  }
  return { command: "npm", args: ["run", candidate.script, "--", ...viteArgs], env };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForServer(url, child, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`UI server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.status < 500) return;
    } catch {
      // Keep polling until the dev server binds.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process already gone.
    }
  }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) {
    await delay(100);
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already gone.
      }
    }
  }
}

function resolveFrom(base, request) {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(request, { paths: [base] });
  } catch {
    return null;
  }
}

function existingNpxPlaywrightPaths() {
  const home = os.homedir();
  const npxRoot = resolve(home, ".npm/_npx");
  if (!existsSync(npxRoot)) return [];
  try {
    return readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(npxRoot, entry.name, "node_modules/playwright"))
      .filter((dir) => existsSync(resolve(dir, "package.json")));
  } catch {
    return [];
  }
}

async function loadPlaywright(candidate) {
  const bases = [
    candidate.dir,
    ROOT,
    process.env.CAPTURE_PLAYWRIGHT_BASE,
    ...existingNpxPlaywrightPaths().map((dir) => dirname(dirname(dir))),
  ].filter(Boolean);

  for (const base of bases) {
    const resolved = resolveFrom(base, "playwright") || resolveFrom(base, "@playwright/test");
    if (!resolved) continue;
    const mod = await import(pathToFileURL(resolved));
    const playwright = mod.default || mod;
    if (playwright.chromium) return playwright;
  }
  throw new Error("Playwright is not available to Node. Install it in the UI package or set CAPTURE_PLAYWRIGHT_BASE.");
}

function slug(input) {
  return String(input || "capture")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "capture";
}

async function gotoState(page, baseUrl, state) {
  const targetUrl = state.url
    ? new URL(state.url, baseUrl).toString()
    : new URL(state.query || "", baseUrl).toString();

  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await page.evaluate(async (stateKey) => {
    const setter =
      window.__VIBERSYN_SET_CAPTURE_STATE__ ||
      window.__VIBERSYN_CAPTURE_SET_STATE__ ||
      window.vibersynSetCaptureState;
    if (typeof setter === "function") await setter(stateKey);
  }, state.key).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(650);
}

async function exposedStates(page) {
  const states = await page
    .evaluate(() => {
      const raw =
        window.__VIBERSYN_CAPTURE_STATES__ ||
        window.__VIBERSYN_DISPLAY_BOARD_STATES__ ||
        window.vibersynCaptureStates;
      if (!Array.isArray(raw)) return [];
      return raw
        .map((state, index) => {
          if (typeof state === "string") return { key: state, title: state, index };
          if (!state || typeof state !== "object") return null;
          const key = String(state.key || state.name || state.id || state.title || `state-${index}`);
          return {
            key,
            title: String(state.title || state.label || key),
            url: state.url ? String(state.url) : undefined,
            query: state.query ? String(state.query) : undefined,
            index,
          };
        })
        .filter(Boolean);
    })
    .catch(() => []);
  return states.slice(0, 8);
}

async function captureScreenshots(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
  const dynamicStates = await exposedStates(page);
  const states =
    dynamicStates.length > 0
      ? dynamicStates.map((state) => ({ ...state, query: state.query || `?capture=${encodeURIComponent(state.key)}` }))
      : STATE_PROBES.flatMap((probe) =>
          probe.queries.slice(0, 1).map((query) => ({ key: probe.key, title: probe.title, query })),
        );

  const written = [];
  for (const [index, state] of states.entries()) {
    await gotoState(page, baseUrl, state);
    const file = `vibersyn-${String(index + 1).padStart(2, "0")}-${slug(state.title)}.png`;
    const path = resolve(CAPTURES_DIR, file);
    await page.screenshot({ path, fullPage: false, animations: "allow" });
    written.push(file);
  }
  return { states, written };
}

async function captureGif(page, baseUrl, states) {
  if (!commandExists("ffmpeg")) {
    log("ffmpeg is not on PATH; skipping GIF capture.");
    return null;
  }

  const gifState =
    states.find((state) => /anim|transition|garden|process|suggest|bubble/i.test(`${state.key} ${state.title}`)) ||
    states[0] ||
    { key: "idle", title: "board-animation", query: "?capture=idle" };

  const tmp = mkdtempSync(resolve(TMP_ROOT, "frames-"));
  try {
    await gotoState(page, baseUrl, gifState);
    for (let i = 0; i < 18; i += 1) {
      if (i === 3) {
        await page.keyboard.press("Space").catch(() => {});
        await page.mouse.move(VIEWPORT.width * 0.55, VIEWPORT.height * 0.52).catch(() => {});
      }
      const frame = resolve(tmp, `frame-${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: frame, fullPage: false, animations: "allow" });
      await page.waitForTimeout(140);
    }

    const out = resolve(CAPTURES_DIR, "vibersyn-90-board-animation.gif");
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        "8",
        "-i",
        resolve(tmp, "frame-%03d.png"),
        "-vf",
        "scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer",
        out,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || "ffmpeg failed to encode GIF");
    }
    return basename(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function regenerateSlideshow() {
  const result = spawnSync(process.execPath, [SLIDESHOW], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`slideshow regeneration failed with code ${result.status}`);
  }
}

async function main() {
  const candidate = discoverUiCandidate();
  if (!candidate) {
    log("no runnable UI yet: no Vite/React/browser display-board package, browser entrypoint, or board story was detected.");
    return;
  }

  mkdirSync(CAPTURES_DIR, { recursive: true });
  mkdirSync(TMP_ROOT, { recursive: true });

  const rel = relative(ROOT, candidate.dir) || ".";
  log(`runnable UI detected at ${rel} (${candidate.reasons.join(", ")}).`);

  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}${candidate.urlPath || "/"}`;
  const { command, args, env } = runArgsFor(candidate, port);
  log(`starting ${command} ${args.join(" ")} on ${baseUrl}`);

  const child = spawn(command, args, {
    cwd: candidate.dir,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(baseUrl, child);
    const playwright = await loadPlaywright(candidate);
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const { states, written } = await captureScreenshots(page, baseUrl);
    const gif = await captureGif(page, baseUrl, states);
    await browser.close();
    browser = null;

    regenerateSlideshow();
    log(`captured ${written.concat(gif ? [gif] : []).join(", ")} and regenerated progress.html.`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopProcess(child);
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${LABEL} ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
