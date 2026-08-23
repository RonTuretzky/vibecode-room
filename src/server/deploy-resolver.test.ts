import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  extractDeployCandidates,
  parseDeployMap,
  resolveDeployUrl,
  type DeployResolverSeams,
} from "./deploy-resolver";
import type { ForestCommandRunner } from "./github-org";

// The deploy-resolver chain, pure end to end: every seam injected (in-memory
// clone files, scripted HEAD probes, scripted gh) — no network, no subprocess.

// Scripted probe: statuses per URL (absent = throw, i.e. DNS-dead), calls
// recorded in order.
function scriptedProbe(statuses: Record<string, number>): {
  calls: Array<{ url: string; method: string | undefined }>;
  probe: NonNullable<DeployResolverSeams["probeFetch"]>;
} {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const probe: NonNullable<DeployResolverSeams["probeFetch"]> = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    const status = statuses[url];
    if (status === undefined) {
      throw new Error(`unreachable: ${url}`);
    }
    return new Response(null, { status });
  };
  return { calls, probe };
}

function cloneSeams(files: Record<string, string>, deployDirFiles: string[] = []): Pick<DeployResolverSeams, "readFile" | "listDir"> {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    listDir: async (path) => {
      if (path.endsWith("deploy") && deployDirFiles.length > 0) {
        return deployDirFiles;
      }
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

const refusingGh: ForestCommandRunner = async () => {
  throw new Error("gh must not run in this test");
};
const emptyGh: ForestCommandRunner = async () => ({ ok: true, stdout: "", stderr: "" });

describe("parseDeployMap", () => {
  test("parses multi-entry maps, trims, and lowercases the owner/repo key", () => {
    const map = parseDeployMap("RonTuretzky/convent-profile=https://residency.convent.fun, acme/Widget = https://widget.example.dev ");
    expect(map.get("ronturetzky/convent-profile")).toBe("https://residency.convent.fun");
    expect(map.get("acme/widget")).toBe("https://widget.example.dev");
  });

  test("skips malformed entries without breaking the others", () => {
    const map = parseDeployMap("broken,=nope,no-slash=https://x.dev,ok/repo=https://ok.dev,ok2/repo=");
    expect(map.size).toBe(1);
    expect(map.get("ok/repo")).toBe("https://ok.dev");
  });

  test("undefined/empty raw is an empty map", () => {
    expect(parseDeployMap(undefined).size).toBe(0);
    expect(parseDeployMap("  ").size).toBe(0);
  });
});

describe("extractDeployCandidates", () => {
  test("finds https URLs (trailing prose punctuation stripped) and promotes bare domains", () => {
    const candidates = extractDeployCandidates(
      "Deployed at https://residency.convent.fun/board, mirror on app.example-site.dev today.",
    );
    expect(candidates).toEqual(["https://residency.convent.fun/board", "https://app.example-site.dev/"]);
  });

  test("skips github/badges/shields/localhost and doc-link hosts", () => {
    const candidates = extractDeployCandidates(
      [
        "[![ci](https://img.shields.io/badge/ci-green.svg)](https://github.com/acme/widget/actions)",
        "clone from https://github.com/acme/widget and run http on localhost:3000 or https://localhost:8443/x",
        "docs: https://www.npmjs.com/package/widget plus https://badgen.net/thing",
        "the real thing: https://widget-app.fly.dev/",
      ].join("\n"),
    );
    expect(candidates).toEqual(["https://widget-app.fly.dev/"]);
  });

  test("bare-domain pass refuses file-extension TLD shapes and email/path fragments", () => {
    const candidates = extractDeployCandidates(
      "edit vite.config.js and README.md, mail admin@convent.fun, then open residency.convent.fun in a browser",
    );
    // The email's domain is glued to "@" (skipped); the standalone mention wins.
    expect(candidates).toEqual(["https://residency.convent.fun/"]);
  });

  test("dedupes by host: the full URL wins over the bare-domain re-match", () => {
    const candidates = extractDeployCandidates("see https://board.example.dev/x and board.example.dev again");
    expect(candidates).toEqual(["https://board.example.dev/x"]);
  });
});

describe("resolveDeployUrl — the chain", () => {
  const input = { owner: "RonTuretzky", repo: "convent-profile", repoDir: "/builds/upid-x/repo" };

  test("(a) VIBERSYN_DEPLOY_MAP wins unconditionally: no probe, no file read, no gh", async () => {
    const probe = scriptedProbe({});
    let reads = 0;
    const resolved = await resolveDeployUrl(input, {
      env: { VIBERSYN_DEPLOY_MAP: "ronturetzky/convent-profile=https://residency.convent.fun" },
      probeFetch: probe.probe,
      readFile: async () => {
        reads += 1;
        return "https://scraped-elsewhere.dev";
      },
      listDir: async () => [],
      ghRunner: refusingGh,
    });
    expect(resolved).toEqual({ url: "https://residency.convent.fun", source: "map" });
    expect(probe.calls).toHaveLength(0);
    expect(reads).toBe(0);
  });

  test("(b) scrape: README candidates HEAD-probed in order; 401 counts as the deployment", async () => {
    const readme = "Try https://old-broken.example-app.dev first, then https://residency.convent.fun (members only).";
    const probe = scriptedProbe({
      "https://old-broken.example-app.dev": 404,
      "https://residency.convent.fun": 401,
    });
    const resolved = await resolveDeployUrl(input, {
      env: {},
      probeFetch: probe.probe,
      ...cloneSeams({ [join(input.repoDir, "README.md")]: readme }),
      ghRunner: refusingGh,
    });
    expect(resolved).toEqual({ url: "https://residency.convent.fun", source: "scrape" });
    expect(probe.calls.map((call) => call.url)).toEqual([
      "https://old-broken.example-app.dev",
      "https://residency.convent.fun",
    ]);
    expect(probe.calls.every((call) => call.method === "HEAD")).toBe(true);
  });

  test("(b) scrape reads deploy/ files too, and a throwing probe just moves on", async () => {
    const probe = scriptedProbe({ "https://board.dokku.example-host.dev": 302 });
    const resolved = await resolveDeployUrl(input, {
      env: {},
      probeFetch: probe.probe,
      ...cloneSeams(
        {
          [join(input.repoDir, "README.md")]: "see https://dns-dead.example-app.dev",
          [join(input.repoDir, "deploy", "Caddyfile")]: "reverse_proxy https://board.dokku.example-host.dev",
        },
        ["Caddyfile"],
      ),
      ghRunner: refusingGh,
    });
    // The README candidate throws (unreachable) — the deploy/ candidate wins on 3xx.
    expect(resolved).toEqual({ url: "https://board.dokku.example-host.dev", source: "scrape" });
  });

  test("(c) gh garnish: homepageUrl probes when the scrape finds nothing", async () => {
    const ghCalls: string[][] = [];
    const gh: ForestCommandRunner = async (argv) => {
      ghCalls.push(argv);
      if (argv[2] === "view") {
        return { ok: true, stdout: "https://homepage.example-app.dev\n", stderr: "" };
      }
      return { ok: true, stdout: "[]", stderr: "" };
    };
    const probe = scriptedProbe({ "https://homepage.example-app.dev": 200 });
    const resolved = await resolveDeployUrl(input, {
      env: {},
      probeFetch: probe.probe,
      ...cloneSeams({}),
      ghRunner: gh,
    });
    expect(resolved).toEqual({ url: "https://homepage.example-app.dev", source: "gh" });
    expect(ghCalls[0]).toEqual([
      "gh", "repo", "view", "RonTuretzky/convent-profile", "--json", "homepageUrl", "--jq", ".homepageUrl",
    ]);
  });

  test("(c) gh garnish: the latest deployment's environment_url is the second candidate", async () => {
    const gh: ForestCommandRunner = async (argv) => {
      if (argv[2] === "view") {
        return { ok: true, stdout: "", stderr: "" }; // no homepage
      }
      if (argv[2]?.endsWith("deployments?per_page=1")) {
        return { ok: true, stdout: JSON.stringify([{ id: 77 }]), stderr: "" };
      }
      if (argv[2]?.includes("deployments/77/statuses")) {
        return { ok: true, stdout: JSON.stringify([{ environment_url: "https://env.example-app.dev" }]), stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    };
    const probe = scriptedProbe({ "https://env.example-app.dev": 200 });
    const resolved = await resolveDeployUrl(input, { env: {}, probeFetch: probe.probe, ...cloneSeams({}), ghRunner: gh });
    expect(resolved).toEqual({ url: "https://env.example-app.dev", source: "gh" });
  });

  test("clone-failed imports (repoDir null) skip the scrape but keep map + gh", async () => {
    let reads = 0;
    const mapped = await resolveDeployUrl(
      { ...input, repoDir: null },
      {
        env: { VIBERSYN_DEPLOY_MAP: "ronturetzky/convent-profile=https://residency.convent.fun" },
        probeFetch: scriptedProbe({}).probe,
        readFile: async () => {
          reads += 1;
          return "";
        },
        ghRunner: refusingGh,
      },
    );
    expect(mapped).toEqual({ url: "https://residency.convent.fun", source: "map" });
    const nothing = await resolveDeployUrl(
      { ...input, repoDir: null },
      { env: {}, probeFetch: scriptedProbe({}).probe, readFile: async () => "https://x.example-app.dev", ghRunner: emptyGh },
    );
    expect(nothing).toBeNull();
    expect(reads).toBe(0);
  });

  test("nothing anywhere → null, and a throwing gh runner never sinks the chain", async () => {
    const resolved = await resolveDeployUrl(input, {
      env: {},
      probeFetch: scriptedProbe({}).probe,
      ...cloneSeams({ [join(input.repoDir, "README.md")]: "no links here, just prose" }),
      ghRunner: refusingGh,
    });
    expect(resolved).toBeNull();
  });
});
