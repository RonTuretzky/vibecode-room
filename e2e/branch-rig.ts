import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDeckRig } from "./deck-rig";

export async function startBranchRig(repoRoot: string) {
  const root = mkdtempSync(join(tmpdir(), "room-branch-rig-"));
  const remotes = join(root, "remotes");
  mkdirSync(remotes);
  const seed = join(root, "seed");
  const remote = join(remotes, "garden-demo.git");
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "--bare", remote]);
  git(["init", "-b", "main", seed]);
  writeFileSync(
    join(seed, "README.md"),
    "# Garden demo\nA static HTML garden used for local flow tests.\n",
  );
  writeFileSync(
    join(seed, "index.html"),
    "<!doctype html><html><body><h1>Garden demo</h1><p>Original garden</p></body></html>",
  );
  git(["-C", seed, "add", "."]);
  git([
    "-C",
    seed,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "seed",
  ]);
  git(["-C", seed, "remote", "add", "origin", remote]);
  git(["-C", seed, "push", "origin", "main"]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  symlinkSync(remote, join(remotes, "garden-demo"));
  const deck = await startDeckRig({ repoRoot });
  const cli = join(root, "claude");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2); const prompt = args[args.indexOf('-p') + 1] || '';
if (!prompt.startsWith("Implement this user's change")) {
 const result = cp.spawnSync(${JSON.stringify(deck.claudePath)}, args, { stdio: 'inherit' }); process.exit(result.status || 0);
}
const request = prompt.split('Requested change:')[1] || '';
if (request.includes('cancel this slow change')) { setTimeout(() => { fs.writeFileSync('late.txt', 'should not land'); console.log(JSON.stringify({result:'late'})); }, 30000); }
else if (request.includes('fail this change')) { console.log(JSON.stringify({is_error:true,result:'Intentional fixture failure'})); }
else {
 let html = fs.readFileSync('index.html', 'utf8');
 if (/dark.mode/i.test(request)) html = html.replace('</body>', '<button onclick="document.body.dataset.theme=\\'dark\\'">Dark mode</button></body>');
 if (/reset/i.test(request)) html = html.replace('</body>', '<button onclick="delete document.body.dataset.theme">Reset theme</button></body>');
 fs.writeFileSync('index.html', html); console.log(JSON.stringify({result:'Implemented requested controls'}));
}
`,
  );
  chmodSync(cli, 0o755);
  const env = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/vibersyn-qa/",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    VIBERSYN_BUILD_BACKENDS: "smithers",
    VIBERSYN_CLAUDE_CLI: cli,
    VIBERSYN_MOCK_ENRICH: "0",
    VIBERSYN_SMITHERS_GATEWAY_URL: `http://127.0.0.1:${deck.gatewayPort}`,
    VIBERSYN_RUN_POLL_MS: "500",
    VIBERSYN_TREE_GIT: "1",
    VIBERSYN_STEER_APPLIER: "1",
    VIBERSYN_STATE_FILE: join(root, "room-state.json"),
    VIBERSYN_RESEARCH_SUGGESTER: "heuristic",
    VIBERSYN_RESEARCH_AGENT: "stub",
  };
  return {
    root,
    env,
    git,
    url: "https://github.com/vibersyn-qa/garden-demo",
    async stop() {
      await deck.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
