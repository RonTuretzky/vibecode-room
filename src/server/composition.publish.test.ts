import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import type { PublishDeckFn, PublishDeckInput, PublishedDeck } from "../publish/gh-pages";
import { TAKE_HOME_SLIDE_MARKER } from "../slideshow/template";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { TranscriptObservation } from "../types";

// TAKE-HOME PUBLISH wiring the composition owns:
//   - the FIRST deck of a kickoff fires ONE fire-and-forget publish (never
//     blocking the kickoff) with the deck dir + this lane's mock dir;
//   - a confirmed publish records publishedUrl + the server QR SVG on the
//     process snapshot, emits process.published, and appends the take-home QR
//     slide to the LOCAL deck;
//   - no PAT in the env -> publishing is cleanly disabled with a trace;
//   - a failed publish traces process.publish.failed and hurts nothing.
// The publisher itself is a fake seam — no GitHub, no network, no PAT.

const BUILDABLE = "let's build a dashboard tool to ship the replay prototype today";
const FAKE_PAT_ENV = { VIBERSYN_GITHUB_PAT: "ghp_fake_pat_for_tests_only" };

class FakeBackend implements BuildBackend {
  readonly id = "native" as const;
  readonly label = "Fake Native";
  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    await Bun.write(join(req.outDir, "index.html"), "<html><body>the mock</body></html>");
    req.onProgress({ label: "ready", percent: 100 });
    return { ok: true, entrypoint: "index.html", summary: "A fake mock, built instantly." };
  }
}

const tempDirs: string[] = [];
let runtimes: ProjectorRuntime[] = [];
let priorCapacityGuard: string | undefined;

beforeEach(() => {
  priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
});

afterEach(async () => {
  if (priorCapacityGuard === undefined) {
    delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  } else {
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
  }
  for (const runtime of runtimes) {
    await runtime.buildOrchestrator.abortEverything().catch(() => undefined);
    await runtime.ideaBuilds.stopAll().catch(() => undefined);
  }
  runtimes = [];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function makeRuntime(
  options: ProjectorRuntimeOptions & { env?: Record<string, string> } = {},
): Promise<{ runtime: ProjectorRuntime; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-publish-comp-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, "", "utf8");
  const { env, ...runtimeOptions } = options;
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_MIC_REPLAY_PATH: path,
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
      VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
      VIBERSYN_DETECT_TICK_MS: "0",
      ...env,
    },
    { buildsRoot: join(dir, "builds"), executionArtifactsRoot: join(dir, "vibersyn-runs"), ...runtimeOptions },
  );
  runtimes.push(runtime);
  runtimePaths.set(runtime, path);
  return { runtime, path };
}

async function drive(runtime: ProjectorRuntime, observations: TranscriptObservation[]): Promise<void> {
  const path = runtimePaths.get(runtime);
  if (path === undefined) {
    throw new Error("drive() called for a runtime makeRuntime did not create");
  }
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  const session = runtime.startMicSession("corr-publish-mic");
  await session.stop();
  await runtime.detection.flush();
}

const runtimePaths = new Map<ProjectorRuntime, string>();

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "publish-test", latencyMs: 0, utteranceId };
}

async function kickoff(runtime: ProjectorRuntime): Promise<string> {
  await drive(runtime, [final(BUILDABLE, "utt-build")]);
  await runtime.acceptPendingSuggestion("corr-publish-accept");
  const upid = runtime.snapshot().processes[0]?.upid;
  if (upid === undefined) {
    throw new Error("kickoff spawned no process");
  }
  await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
  await waitFor(() => runtime.registry.builds(upid)[0]?.slideshowUrl !== null);
  return upid;
}

describe("take-home publish wiring", () => {
  test("first deck fires one publish; confirmed 200 records publishedUrl + QR on the snapshot, traces, and patches the local deck", async () => {
    const calls: PublishDeckInput[] = [];
    let resolvePublish: (value: PublishedDeck) => void = () => undefined;
    const publishDeckFake: PublishDeckFn = async (input) => {
      calls.push(input);
      return await new Promise<PublishedDeck>((resolve) => {
        resolvePublish = resolve;
      });
    };
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      publishDeck: publishDeckFake,
      env: FAKE_PAT_ENV,
    });
    const upid = await kickoff(runtime);
    await waitFor(() => calls.length === 1);

    // The publish carries the deck dir, this lane's mock dir, and the naming
    // facts (title may still be the deterministic one — that is the contract).
    expect(calls[0]?.upid).toBe(upid);
    expect(calls[0]?.deckDir.endsWith(join("native", "slideshow"))).toBe(true);
    expect(calls[0]?.mockDirs.native?.endsWith("native")).toBe(true);
    expect(calls[0]?.handle).toBe(runtime.snapshot().processes[0]?.callsign ?? "");

    // Until the public URL confirms, nothing is on the snapshot.
    expect(runtime.publishNow().processes[0]?.publishedUrl ?? null).toBeNull();

    resolvePublish({
      url: "https://roomtester.github.io/replay-dashboard/",
      login: "roomtester",
      repo: "replay-dashboard",
      repoUrl: "https://github.com/roomtester/replay-dashboard",
      filesUploaded: 3,
    });
    await waitFor(() => runtime.snapshot().processes[0]?.publishedUrl === "https://roomtester.github.io/replay-dashboard/");

    // Snapshot: the URL + a real server-generated QR SVG.
    const process = runtime.publishNow().processes[0];
    expect(process?.publishedUrl).toBe("https://roomtester.github.io/replay-dashboard/");
    expect(process?.publishedQrSvg).toContain("<svg");
    // Trace: process.published with the URL.
    const published = runtime.trace.events().find((event) => event.event === "process.published");
    expect(published).toBeDefined();
    expect(published?.upid).toBe(upid);
    expect(published?.meta.url).toBe("https://roomtester.github.io/replay-dashboard/");
    // The LOCAL deck gained the final take-home QR slide.
    await waitFor(() => calls[0] !== undefined);
    const deckHtml = await Bun.file(join(calls[0]!.deckDir, "index.html")).text();
    expect(deckHtml).toContain(TAKE_HOME_SLIDE_MARKER);
    expect(deckHtml).toContain("https://roomtester.github.io/replay-dashboard/");
    // Exactly one publish attempt ever fired for this UPID.
    expect(calls).toHaveLength(1);
  });

  test("no PAT in the environment: publishing is cleanly disabled with a trace and the seam is never called", async () => {
    let calls = 0;
    const publishDeckFake: PublishDeckFn = async () => {
      calls += 1;
      throw new Error("must not be called");
    };
    const { runtime } = await makeRuntime({ buildBackends: [new FakeBackend()], publishDeck: publishDeckFake });
    const upid = await kickoff(runtime);
    await waitFor(() => runtime.trace.events().some((event) => event.event === "process.publish.disabled"));

    const disabled = runtime.trace.events().find((event) => event.event === "process.publish.disabled");
    expect(disabled?.upid).toBe(upid);
    expect(disabled?.meta.reason).toBe("no-github-pat");
    expect(calls).toBe(0);
    expect(runtime.publishNow().processes[0]?.publishedUrl ?? null).toBeNull();
  });

  test("a failed publish traces process.publish.failed and leaves the kickoff untouched", async () => {
    const publishDeckFake: PublishDeckFn = async () => {
      throw new Error("Pages build never confirmed");
    };
    const { runtime } = await makeRuntime({
      buildBackends: [new FakeBackend()],
      publishDeck: publishDeckFake,
      env: FAKE_PAT_ENV,
    });
    const upid = await kickoff(runtime);
    await waitFor(() => runtime.trace.events().some((event) => event.event === "process.publish.failed"));

    const failed = runtime.trace.events().find((event) => event.event === "process.publish.failed");
    expect(failed?.upid).toBe(upid);
    expect(failed?.meta.error).toBe("Pages build never confirmed");
    // The kickoff surface is intact: the mock lane is still ready with a deck.
    expect(runtime.registry.builds(upid)[0]?.status).toBe("ready");
    expect(runtime.publishNow().processes[0]?.publishedUrl ?? null).toBeNull();
  });
});
