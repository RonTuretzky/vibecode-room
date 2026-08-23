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
    expect(config.badge).toBe("WALL A");
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

  test("?dwell=mouse enables the mouse-dwell fallback WITHOUT gesture mode", () => {
    const config = parseProjectorUrl("?dwell=mouse", "h");
    expect(config.dwell).toBe("mouse");
    expect(config.gesture).toBeNull(); // OS cursor stays; only the dwell layer mounts
  });

  test("dwell defaults to null and rejects unknown values", () => {
    expect(parseProjectorUrl("", "h").dwell).toBeNull();
    expect(parseProjectorUrl("?dwell=eyeball", "h").dwell).toBeNull();
    // Gesture mode does not imply the mouse-test cursor.
    expect(parseProjectorUrl("?gesture=1", "h").dwell).toBeNull();
  });

  test("?gesture=1&dwell=mouse combines: fusion cursors + the mouse test cursor", () => {
    const config = parseProjectorUrl("?gesture=1&dwell=mouse", "h");
    expect(config.gesture).not.toBeNull();
    expect(config.dwell).toBe("mouse");
  });

  // The pinch camera (?hands=) is camera CONTROL only — opt-in and fully
  // independent of the dwell/gesture layers.
  test("hands defaults to null: bare URL, ?hands=0 and empty ?hands= stay off", () => {
    expect(parseProjectorUrl("", "h").hands).toBeNull();
    expect(parseProjectorUrl("?hands=0", "h").hands).toBeNull();
    expect(parseProjectorUrl("?hands=", "h").hands).toBeNull();
  });

  test("?hands=1 opts in with the default TD URL on the page's hostname", () => {
    expect(parseProjectorUrl("?hands=1", "myhost").hands).toEqual({ url: "ws://myhost:9980" });
    expect(parseProjectorUrl("?hands=1", "").hands).toEqual({ url: "ws://localhost:9980" });
  });

  test("?hands=ws://... names an explicit stream source", () => {
    expect(parseProjectorUrl("?hands=ws://td:9980", "h").hands).toEqual({ url: "ws://td:9980" });
  });

  test("?hands= values are trimmed before comparison: padded off-values stay off, padded on-values opt in", () => {
    expect(parseProjectorUrl("?hands=0%20", "h").hands).toBeNull();
    expect(parseProjectorUrl("?hands=%20%20", "h").hands).toBeNull();
    expect(parseProjectorUrl("?hands=1%20", "h").hands).toEqual({ url: "ws://h:9980" });
    expect(parseProjectorUrl("?hands=%20ws://td:9980%20", "h").hands).toEqual({ url: "ws://td:9980" });
  });

  test("?gesture=1&hands=1 combines: dwell layer AND pinch camera both on", () => {
    const config = parseProjectorUrl("?gesture=1&hands=1", "h");
    expect(config.gesture).not.toBeNull();
    expect(config.hands).not.toBeNull();
  });

  // The view param scopes each wall's 2D surfaces + controls (ideas vs builds;
  // the 3D scene always stays full — see projector tests for the render table).
  test("view parsing: ideas/builds are recognized, anything else falls back to full", () => {
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

  // DE-THEME: the walls are one continuous room, so a wall badge is just the
  // wall identity — never "IDEAS"/"BUILDS" branding (the view only places
  // panels, it does not theme a wall).
  test("wall badge is the bare wall identity, regardless of view", () => {
    expect(parseProjectorUrl("?wall=b&view=builds", "h").badge).toBe("WALL B");
    expect(parseProjectorUrl("?wall=A", "h").badge).toBe("WALL A");
  });

  test("?demo=guided auto-enters the guided demo; anything else stays off", () => {
    expect(parseProjectorUrl("?demo=guided", "h").demo).toBe("guided");
    expect(parseProjectorUrl("?demo=other", "h").demo).toBeNull();
    expect(parseProjectorUrl("", "h").demo).toBeNull();
  });

  test("?mock=1 exposes the Mock Room toggle; default hides it (no-mocks audit)", () => {
    expect(parseProjectorUrl("?mock=1", "h").mock).toBe(true);
    expect(parseProjectorUrl("?mock=0", "h").mock).toBe(false);
    expect(parseProjectorUrl("", "h").mock).toBe(false);
  });

  test("remote (guest hands) is ON by default; only an explicit ?remote=0 opts out", () => {
    expect(parseProjectorUrl("", "h").remote).toEqual({ url: null });
    expect(parseProjectorUrl("?live=1&wall=A", "h").remote).toEqual({ url: null });
    expect(parseProjectorUrl("?remote=1", "h").remote).toEqual({ url: null });
    expect(parseProjectorUrl("?remote=", "h").remote).toEqual({ url: null });
    expect(parseProjectorUrl("?remote=0", "h").remote).toBeNull();
    expect(parseProjectorUrl("?remote=%200%20", "h").remote).toBeNull(); // trimmed "0 "
  });

  test("?remote=ws://... names an explicit subscription source (split-origin dev)", () => {
    expect(parseProjectorUrl("?remote=ws%3A%2F%2F192.168.1.20%3A8788%2Fapi%2Fhands%2Froom", "h").remote).toEqual({
      url: "ws://192.168.1.20:8788/api/hands/room",
    });
  });

  test("?remote=1 composes with gesture and dwell modes", () => {
    const config = parseProjectorUrl("?gesture=1&dwell=mouse&remote=1", "h");
    expect(config.gesture).not.toBeNull();
    expect(config.dwell).toBe("mouse");
    expect(config.remote).toEqual({ url: null });
  });

  // FLAT RIG (?flat=1): the wall pair renders halves of one wide view so two
  // side-by-side projections on ONE flat wall tile a continuous picture.
  test("?flat=1 opts into the flat-wall pair; anything else stays off", () => {
    expect(parseProjectorUrl("?flat=1", "h").flat).toBe(true);
    expect(parseProjectorUrl("?flat=0", "h").flat).toBe(false);
    expect(parseProjectorUrl("?flat=yes", "h").flat).toBe(false);
    expect(parseProjectorUrl("", "h").flat).toBe(false);
  });

  test("?flat=1 composes with the wall identity and gesture params untouched", () => {
    const config = parseProjectorUrl("?live=1&wall=B&view=builds&gesture=1&flat=1", "h");
    expect(config.flat).toBe(true);
    expect(config.wall).toBe("B");
    expect(config.gesture?.wall).toBe("B");
  });

  // Cursor dots default VISIBLE (live-room reversal: an invisible pointer
  // reads as a dead joystick). The URL is a tri-state override; absent means
  // the stored preference — itself default-visible — decides.
  test("?dots is a tri-state override and absent never means hidden", () => {
    expect(parseProjectorUrl("?dots=1", "h").dots).toBe(true);
    expect(parseProjectorUrl("?dots=0", "h").dots).toBe(false);
    expect(parseProjectorUrl("", "h").dots).toBeNull();
  });

  // JOYSTICK CURSOR SOURCE (?stick=1, appended by run-room.sh --arcade): both
  // fusion sources speak the same ws protocol, so only the launcher knows —
  // the flag makes the guided demo coach lever+button instead of hand.
  test("?stick=1 marks the joystick rig; default and junk stay false", () => {
    expect(parseProjectorUrl("?stick=1", "h").stick).toBe(true);
    expect(parseProjectorUrl("?stick=0", "h").stick).toBe(false);
    expect(parseProjectorUrl("?stick=yes", "h").stick).toBe(false);
    expect(parseProjectorUrl("", "h").stick).toBe(false);
  });

  test("?stick=1 composes with the gesture layer + dots (the run-room arcade URL shape)", () => {
    const config = parseProjectorUrl("?live=1&wall=A&gesture=1&dots=1&stick=1", "h");
    expect(config.stick).toBe(true);
    expect(config.gesture).not.toBeNull();
    expect(config.dots).toBe(true);
  });

  // CONTINUOUS AUTO-FRAMING (?autofit=): tri-state override for the
  // self-driving camera. App defaults it ON for research-pinned windows
  // (?research=1 — the ceiling projector); the URL param forces either way.
  test("?autofit=1 forces auto-framing on; ?autofit=0 forces it off", () => {
    expect(parseProjectorUrl("?autofit=1", "h").autoFit).toBe(true);
    expect(parseProjectorUrl("?autofit=0", "h").autoFit).toBe(false);
  });

  test("absent/unknown ?autofit defers to the default (null tri-state)", () => {
    expect(parseProjectorUrl("", "h").autoFit).toBeNull();
    expect(parseProjectorUrl("?research=1", "h").autoFit).toBeNull();
    expect(parseProjectorUrl("?autofit=yes", "h").autoFit).toBeNull();
    expect(parseProjectorUrl("?autofit=", "h").autoFit).toBeNull();
  });

  test("?autofit composes with the research pin untouched (ceiling projector opt-out)", () => {
    const config = parseProjectorUrl("?research=1&autofit=0", "h");
    expect(config.research).toBe(true);
    expect(config.autoFit).toBe(false);
  });
});
