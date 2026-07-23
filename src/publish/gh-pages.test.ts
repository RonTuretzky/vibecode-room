import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSlideshow } from "../slideshow/generator";
import {
  GITHUB_API_URL,
  PublishError,
  publishDeck,
  resolveGitHubPat,
  rewriteDeckForStandalone,
  slugifyProjectName,
} from "./gh-pages";

// Unit + integration coverage for the GitHub Pages deck publisher. Everything
// network-shaped goes through an injected fetch fake — no real GitHub, no PAT.

const FAKE_PAT = "ghp_fake_pat_for_tests_only";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-publish-"));
  tempDirs.push(dir);
  return dir;
}

// Build a REAL local deck (deterministic copy, no network) plus a mock lane on
// disk, mirroring exactly what the kickoff orchestrator leaves behind.
async function makeLocalDeck(): Promise<{ deckDir: string; mockDir: string }> {
  const mockDir = join(tempDir(), "native");
  await mkdir(mockDir, { recursive: true });
  await writeFile(join(mockDir, "index.html"), "<html><body>the native mock</body></html>", "utf8");
  await writeFile(join(mockDir, "app.js"), "console.log('mock');", "utf8");
  const artifact = await generateSlideshow(
    {
      upid: "upid-7",
      ideaId: "idea-7",
      prompt: "an app that calculates how much snow you can sip",
      callsign: "falcon",
      backend: "native",
      outDir: mockDir,
      summary: "A cheeky calculator that turns snowfall into sippable volume.",
    },
    { model: async () => null },
  );
  return { deckDir: artifact.dir, mockDir };
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

// Scripted GitHub: answers /user, /user/repos (with optional collisions),
// contents PUTs, the Pages POST, and the public-URL poll.
function fakeGitHub(script: { repoCollisions?: number; pagesStatus?: number; pollStatuses?: number[] } = {}) {
  const requests: RecordedRequest[] = [];
  let collisionsLeft = script.repoCollisions ?? 0;
  const pollStatuses = [...(script.pollStatuses ?? [200])];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ method, url, body });
    const respond = (status: number, payload: unknown = {}) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (url === `${GITHUB_API_URL}/user`) {
      return respond(200, { login: "roomtester" });
    }
    if (url === `${GITHUB_API_URL}/user/repos` && method === "POST") {
      if (collisionsLeft > 0) {
        collisionsLeft -= 1;
        return respond(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      }
      return respond(201, { name: (body as Record<string, unknown>).name });
    }
    if (url.startsWith(`${GITHUB_API_URL}/repos/roomtester/`) && url.includes("/contents/") && method === "PUT") {
      return respond(201, { content: { path: "x" } });
    }
    if (url.startsWith(`${GITHUB_API_URL}/repos/roomtester/`) && url.endsWith("/pages") && method === "POST") {
      return respond(script.pagesStatus ?? 201, {});
    }
    if (url.startsWith("https://roomtester.github.io/")) {
      const status = pollStatuses.length > 1 ? pollStatuses.shift()! : pollStatuses[0]!;
      return new Response(status === 200 ? "<html>deck</html>" : "not yet", { status });
    }
    return respond(500, { message: `unscripted ${method} ${url}` });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const NO_SLEEP = async () => undefined;

describe("resolveGitHubPat", () => {
  test("prefers VIBERSYN_GITHUB_PAT, then GITHUB_PAT, then GH_TOKEN; null when none", () => {
    expect(resolveGitHubPat({ VIBERSYN_GITHUB_PAT: "a", GITHUB_PAT: "b", GH_TOKEN: "c" })).toBe("a");
    expect(resolveGitHubPat({ GITHUB_PAT: "b", GH_TOKEN: "c" })).toBe("b");
    expect(resolveGitHubPat({ GH_TOKEN: " c " })).toBe("c");
    expect(resolveGitHubPat({ VIBERSYN_GITHUB_PAT: "  " })).toBeNull();
    expect(resolveGitHubPat({})).toBeNull();
  });
});

describe("slugifyProjectName", () => {
  test("reads as the project: lowercase, hyphens, alnum only", () => {
    expect(slugifyProjectName("Snow Sip Calculator")).toBe("snow-sip-calculator");
    expect(slugifyProjectName("  Fish—Tank!! Dashboard 2 ")).toBe("fish-tank-dashboard-2");
    expect(slugifyProjectName("!!!")).toBe("");
  });
});

describe("rewriteDeckForStandalone", () => {
  test("mock iframes go relative for bundled lanes, decision buttons become the take-home note", async () => {
    const { deckDir } = await makeLocalDeck();
    const html = await Bun.file(join(deckDir, "index.html")).text();
    const out = rewriteDeckForStandalone(html, ["native"]);
    // The gallery iframe now points at the bundled relative copy.
    expect(out).toContain('src="./mocks/native/index.html"');
    expect(out).not.toContain('src="../"');
    // The room-local decision POST buttons + steer form are gone (the static
    // deck script may still MENTION the attributes; no markup carries them, so
    // nothing can POST); the take-home note is in.
    expect(out).not.toContain('<button class="decision"');
    expect(out).not.toContain('<form class="decision-form"');
    expect(out).not.toContain('data-endpoint="/api/');
    expect(out).toContain("This deck is a take-home — the room is where you decide.");
    // The idea, title, and mock gallery survive intact.
    expect(out).toContain("an app that calculates how much snow you can sip");
    expect(out).toContain("The idea, verbatim");
    expect(out).toContain("data-mock-panel=");
  });

  test("a lane that did not bundle shows the missing panel instead of a dead loopback URL", async () => {
    const { deckDir } = await makeLocalDeck();
    const html = await Bun.file(join(deckDir, "index.html")).text();
    const out = rewriteDeckForStandalone(html, []);
    expect(out).not.toContain("<iframe");
    expect(out).toContain("this mock did not travel");
  });
});

describe("publishDeck", () => {
  test("full happy path: login → repo → .nojekyll-first bundle → pages → public 200", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub({ pollStatuses: [404, 404, 200] });
    const result = await publishDeck(
      {
        upid: "upid-7",
        handle: "falcon",
        title: "Snow Sip Calculator",
        deckDir,
        mockDirs: { native: mockDir },
      },
      { fetchImpl: github.fetchImpl, env: { VIBERSYN_GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP, pollIntervalMs: 1 },
    );

    expect(result.login).toBe("roomtester");
    expect(result.repo).toBe("snow-sip-calculator");
    expect(result.url).toBe("https://roomtester.github.io/snow-sip-calculator/");
    expect(result.repoUrl).toBe("https://github.com/roomtester/snow-sip-calculator");

    // Repo is created public, named after the inferred project.
    const create = github.requests.find((request) => request.method === "POST" && request.url.endsWith("/user/repos"));
    expect((create?.body as Record<string, unknown>).name).toBe("snow-sip-calculator");
    expect((create?.body as Record<string, unknown>).private).toBe(false);

    // Upload order: .nojekyll FIRST (Pages first-build no-op guard), then the
    // rewritten index.html, then the bundled mock files.
    const puts = github.requests.filter((request) => request.method === "PUT").map((request) => request.url.split("/contents/")[1]);
    expect(puts[0]).toBe(".nojekyll");
    expect(puts[1]).toBe("index.html");
    expect(puts).toContain("mocks/native/index.html");
    expect(puts).toContain("mocks/native/app.js");
    // The deck's slideshow/ subdir is NOT bundled into the mock copy.
    expect(puts.some((path) => path?.includes("mocks/native/slideshow"))).toBe(false);
    expect(result.filesUploaded).toBe(puts.length);

    // The uploaded index.html is the standalone rewrite.
    const indexPut = github.requests.find((request) => request.method === "PUT" && request.url.endsWith("/contents/index.html"));
    const uploaded = Buffer.from((indexPut?.body as Record<string, string>).content, "base64").toString("utf8");
    expect(uploaded).toContain('src="./mocks/native/index.html"');
    expect(uploaded).not.toContain('data-endpoint="/api/');
    // Every PUT lands on main.
    expect((indexPut?.body as Record<string, unknown>).branch).toBe("main");

    // Pages enabled legacy from main /.
    const pages = github.requests.find((request) => request.method === "POST" && request.url.endsWith("/pages"));
    expect(pages?.body).toEqual({ build_type: "legacy", source: { branch: "main", path: "/" } });

    // The public URL was polled through the 404s to the confirming 200.
    const polls = github.requests.filter((request) => request.url.startsWith("https://roomtester.github.io/"));
    expect(polls.length).toBe(3);
  });

  test("a colliding name retries with -2, -3 … so the URL still reads as the project", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub({ repoCollisions: 2 });
    const result = await publishDeck(
      { upid: "upid-7", handle: "falcon", title: "Snow Sip Calculator", deckDir, mockDirs: { native: mockDir } },
      { fetchImpl: github.fetchImpl, env: { GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP, pollIntervalMs: 1 },
    );
    expect(result.repo).toBe("snow-sip-calculator-3");
    expect(result.url).toBe("https://roomtester.github.io/snow-sip-calculator-3/");
  });

  test("an empty title slugs from the handle, then the upid", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub();
    const result = await publishDeck(
      { upid: "upid-7", handle: "falcon", title: null, deckDir, mockDirs: { native: mockDir } },
      { fetchImpl: github.fetchImpl, env: { VIBERSYN_GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP, pollIntervalMs: 1 },
    );
    expect(result.repo).toBe("falcon");
  });

  test("pages already enabled (409) is the goal state, not a failure", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub({ pagesStatus: 409 });
    const result = await publishDeck(
      { upid: "upid-7", handle: "falcon", title: "Snow Sip Calculator", deckDir, mockDirs: { native: mockDir } },
      { fetchImpl: github.fetchImpl, env: { VIBERSYN_GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP, pollIntervalMs: 1 },
    );
    expect(result.url).toBe("https://roomtester.github.io/snow-sip-calculator/");
  });

  test("no PAT throws cleanly before any network call", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub();
    await expect(
      publishDeck(
        { upid: "upid-7", handle: "falcon", title: "x", deckDir, mockDirs: { native: mockDir } },
        { fetchImpl: github.fetchImpl, env: {}, sleep: NO_SLEEP },
      ),
    ).rejects.toMatchObject({ stage: "no-pat" });
    expect(github.requests).toHaveLength(0);
  });

  test("a public URL that never serves 200 inside the budget throws poll-timeout naming the repo", async () => {
    const { deckDir, mockDir } = await makeLocalDeck();
    const github = fakeGitHub({ pollStatuses: [404] });
    await expect(
      publishDeck(
        { upid: "upid-7", handle: "falcon", title: "Snow Sip Calculator", deckDir, mockDirs: { native: mockDir } },
        {
          fetchImpl: github.fetchImpl,
          env: { VIBERSYN_GITHUB_PAT: FAKE_PAT },
          sleep: NO_SLEEP,
          pollIntervalMs: 10,
          pollBudgetMs: 25,
        },
      ),
    ).rejects.toMatchObject({ stage: "poll-timeout" });
    try {
      await publishDeck(
        { upid: "upid-7", handle: "falcon", title: "Snow Sip Calculator", deckDir, mockDirs: { native: mockDir } },
        { fetchImpl: github.fetchImpl, env: { VIBERSYN_GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP, pollIntervalMs: 10, pollBudgetMs: 25 },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError);
      expect((error as PublishError).message).toContain("roomtester/snow-sip-calculator");
    }
  });

  test("a missing local deck throws deck-missing before touching the network", async () => {
    const github = fakeGitHub();
    await expect(
      publishDeck(
        { upid: "upid-7", handle: "falcon", title: "x", deckDir: join(tempDir(), "nope"), mockDirs: {} },
        { fetchImpl: github.fetchImpl, env: { VIBERSYN_GITHUB_PAT: FAKE_PAT }, sleep: NO_SLEEP },
      ),
    ).rejects.toMatchObject({ stage: "deck-missing" });
    expect(github.requests).toHaveLength(0);
  });
});
