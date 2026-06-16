import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectorApp, REQUIRED_PROJECTOR_REGIONS } from "./App";
import { demoProjectorSnapshot } from "./demo-data";

describe("projector UI contract", () => {
  test("renders every required projector region from deterministic demo state", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);

    for (const region of REQUIRED_PROJECTOR_REGIONS) {
      expect(html).toContain(`data-region="${region}"`);
    }

    expect(html).toContain("Atlas");
    expect(html).toContain("Cobalt");
    expect(html).toContain("Turn the meeting notes into a blocker announcer.");
    expect(html).toContain("route.action");
  });

  test("shows the bounded unmute control only while muted", () => {
    const mutedHtml = renderToStaticMarkup(<ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, muted: true, listening: false }} />);
    const listeningHtml = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);

    expect(mutedHtml).toContain("Unmute");
    expect(listeningHtml).not.toContain("Unmute");
  });
});
