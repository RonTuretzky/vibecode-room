import { describe, expect, test } from "bun:test";
import { parseProjectorUrl } from "./url-params";

describe("parseProjectorUrl", () => {
  test("bare URL: full view, no wall, no badge, NO gesture layer", () => {
    const config = parseProjectorUrl("", "localhost");
    expect(config.view).toBe("full");
    expect(config.wall).toBeNull();
    expect(config.badge).toBeNull();
    expect(config.gesture).toBeNull();
  });

  test("?wall=A alone is an identity badge only — gesture stays OFF (desk mode default)", () => {
    const config = parseProjectorUrl("?wall=A&view=ideas", "192.168.1.20");
    expect(config.gesture).toBeNull();
    expect(config.wall).toBe("A");
    expect(config.badge).toBe("WALL A · IDEAS");
  });

  test("?gesture=1 explicitly mounts the gesture layer with the default fusion URL", () => {
    const config = parseProjectorUrl("?wall=B&gesture=1", "myhost");
    expect(config.gesture).toEqual({ wall: "B", fusionUrl: "ws://myhost:8770" });
  });

  test("?fusion= present is an explicit gesture request (old links keep working)", () => {
    const withUrl = parseProjectorUrl("?wall=A&fusion=ws://10.0.0.5:8770", "localhost");
    expect(withUrl.gesture).toEqual({ wall: "A", fusionUrl: "ws://10.0.0.5:8770" });

    // Empty ?fusion= still opts in, falling back to the default URL; a missing
    // wall id defaults to "A" so the layer can subscribe to something.
    const empty = parseProjectorUrl("?fusion=", "");
    expect(empty.gesture).toEqual({ wall: "A", fusionUrl: "ws://localhost:8770" });
  });

  test("view parsing: ideas/builds are honored, anything else falls back to full", () => {
    expect(parseProjectorUrl("?view=ideas", "h").view).toBe("ideas");
    expect(parseProjectorUrl("?view=builds", "h").view).toBe("builds");
    expect(parseProjectorUrl("?view=bogus", "h").view).toBe("full");
    expect(parseProjectorUrl("?view=full", "h").view).toBe("full");
  });

  test("explicit view without a wall still shows a badge", () => {
    expect(parseProjectorUrl("?view=builds", "h").badge).toBe("BUILDS");
    expect(parseProjectorUrl("?view=full", "h").badge).toBe("FULL");
    // Implicit full view (no params) shows no badge — the plain single-window UI.
    expect(parseProjectorUrl("?live=1", "h").badge).toBeNull();
  });

  test("wall badge always carries the view so two-wall setups read at a glance", () => {
    expect(parseProjectorUrl("?wall=b&view=builds", "h").badge).toBe("WALL B · BUILDS");
    expect(parseProjectorUrl("?wall=A", "h").badge).toBe("WALL A · FULL");
  });
});
