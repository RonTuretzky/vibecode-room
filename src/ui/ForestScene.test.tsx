import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForestScene, forestCiWord } from "./ForestScene";
import type { ForestPayload } from "./forest-spec";

// SSR smoke: the scene mounts its WebGL world in an effect, so a server
// render (no window, no effects) must emit ONLY the container shell — never
// touch three.js, canvas or DOM APIs.

const demoForest: ForestPayload = {
  org: "acme",
  fetchedAtMs: Date.parse("2026-08-09T00:00:00Z"),
  repos: [
    {
      name: "widget",
      pushedAtMs: Date.parse("2026-08-08T00:00:00Z"),
      prs: [
        { number: 12, title: "Add the grove renderer", draft: false, ci: "pass", baseRef: "main", headRef: "feat/grove" },
        { number: 13, title: "Polish lighting", draft: true, ci: "pending", baseRef: "feat/grove", headRef: "feat/polish", stackedOn: 12 },
      ],
      issues: [{ number: 3, title: "Crash on load", labels: ["bug"] }],
    },
  ],
};

describe("ForestScene — SSR smoke", () => {
  test("renders the empty-forest container without a window", () => {
    const html = renderToStaticMarkup(<ForestScene forest={null} issuesVisible={false} />);
    expect(html).toContain('data-testid="forest-scene"');
    expect(html).toContain('data-repo-count="0"');
    expect(html).toContain("no org imported");
    expect(html).not.toContain("<canvas");
  });

  test("{org:null} loading state renders the same empty shell", () => {
    const html = renderToStaticMarkup(<ForestScene forest={{ org: null, loading: "acme" }} issuesVisible={false} />);
    expect(html).toContain('data-repo-count="0"');
  });

  test("a live payload renders the shell with org identity + toggle state (canvas comes later, client-side)", () => {
    const html = renderToStaticMarkup(<ForestScene forest={demoForest} issuesVisible onPick={() => undefined} />);
    expect(html).toContain('data-org="acme"');
    expect(html).toContain('data-repo-count="1"');
    expect(html).toContain('data-issues-visible="true"');
    expect(html).toContain("GitHub forest: acme, 1 repo");
    expect(html).not.toContain("<canvas");
  });
});

describe("forestCiWord", () => {
  test("hover-card phrasing for every CI verdict", () => {
    expect(forestCiWord("pass")).toBe("CI passing");
    expect(forestCiWord("fail")).toBe("CI failing");
    expect(forestCiWord("pending")).toBe("CI pending");
    expect(forestCiWord("none")).toBe("no CI");
  });
});
