/**
 * MEASURE THE TEND CHIPS AS THEY REALLY RENDER — a throwaway-safe probe, not a
 * gate. The pure layout budgets from NOMINAL footprints (tend-radial.ts); the
 * browser lays out the real content. When a nominal under-states what a chip
 * draws, the chip below it is painted over — and a covered chip centre is a
 * dead dwell target, which no nominal-only test can see.
 *
 * Renders the tend surface, applies the SAME pure layout the wall applies (in
 * both families), and reports every rendered rect + every overlap.
 *
 *   bun scripts/measure-tend-chips.tsx            # both families, armed grow
 *   bun scripts/measure-tend-chips.tsx --idle     # idle grow chip
 *   bun scripts/measure-tend-chips.tsx --self     # the mirror's own surface
 *   bun scripts/measure-tend-chips.tsx --squeeze 200   # force the shrink path
 *   bun scripts/measure-tend-chips.tsx --json     # the table tend-radial.test.ts pins
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { TreeMenu } from "../src/ui/TreeMenu";
import { tendChipLayout, tendChipSize, type TendChipId } from "../src/ui/tend-radial";
import { demoProjectorSnapshot } from "../src/ui/demo-data";
import type { ProjectorProcess, ProjectorSnapshot } from "../src/ui/types";

const ROOT = join(import.meta.dir, "..");
const armed = !process.argv.includes("--idle");
// The SELF tree's own tending surface (the graft chip renders the identical
// record toggle the grow chip does — measure it on the same terms).
const self = process.argv.includes("--self");
const squeezeArg = process.argv.indexOf("--squeeze");
const squeeze = squeezeArg === -1 ? 0 : Number(process.argv[squeezeArg + 1] ?? 0);

const REMOTE = "https://github.com/acme/pr-triage";
const base = demoProjectorSnapshot.processes[0]!;
// THE BUSIEST ADOPTED FLEET TREE THE MENU CAN ACTUALLY RENDER: every optional
// chip switched on at once (execution receipt, brief, live app, deck, a full
// page of rails plus the pager, the grow record surface, both honest receipts,
// replant, and the take-home QR).
const fleetProcess = (): ProjectorProcess =>
  ({
    ...base,
    slides: [{ title: "s", body: "b" }],
    deployUrl: "https://pr-triage.example.com",
    publishedUrl: "https://roomowner.github.io/pr-triage",
    publishedQrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="#fff"/></svg>',
    execution: { status: "executing", progressLabel: "writing the change", previewUrl: null },
    treeRepo: {
      branches: [
        { name: "main", commits: 5 },
        { name: "room/spoken-changes", commits: 3, prUrl: `${REMOTE}/pull/7` },
        ...Array.from({ length: 4 }, (_, index) => ({ name: `room/change-${index + 1}`, commits: index + 1 })),
      ],
      remoteUrl: REMOTE,
      adopted: true,
    },
    ...(armed ? { steering: true, steeringSince: "12:04:30", steeringMode: "grow" as const } : {}),
  }) as unknown as ProjectorProcess;

// The MIRROR's busiest list view: the graft record chip, the growing card, the
// here-card, a full page of rails + pager, both receipts, the take-home QR.
const selfProcess = (): ProjectorProcess =>
  ({
    ...fleetProcess(),
    stage: "self",
    ...(armed ? { steering: true, steeringSince: "12:04:30", steeringMode: "onto" as const } : {}),
  }) as unknown as ProjectorProcess;

// THE WORST CASE THE ECHO CAN DRAW: the toggle prints the last FOUR lines
// spoken inside the window, each long enough to wrap. Anything shorter
// under-measures the chip and hands back a nominal that fits only quiet rooms.
const LONG = "the standup notes keep losing blockers and the board needs a proper dark mode before friday";
const snapshot: ProjectorSnapshot = {
  ...demoProjectorSnapshot,
  transcript: [
    ...demoProjectorSnapshot.transcript,
    ...Array.from({ length: 5 }, (_, index) => ({
      time: `12:0${5 + index}:00`,
      speaker: "Room",
      text: `${LONG} (${index + 1})`,
      kind: "room" as const,
    })),
  ],
  ...(armed ? { steeringUpid: base.upid } : {}),
};

const markup = renderToStaticMarkup(
  <TreeMenu
    process={self ? selfProcess() : fleetProcess()}
    snapshot={snapshot}
    anchor={{ left: 820, top: 300, width: 280, height: 420 }}
    onClose={() => {}}
    onOpenDeck={() => {}}
    onDismiss={() => {}}
    onReplant={() => {}}
    onOpenBrief={() => {}}
    onOpenLiveApp={() => {}}
    tendSeed={{
      note: "🌱 grown — room/give-board-proper-dark is a new limb on this tree",
      error: "branch rails are for adopted GitHub imports — local trees publish via publish-repo",
    }}
  />,
);

// The ids the surface REALLY rendered (never a hand-kept list that can drift).
const present = [...markup.matchAll(/data-chip="([^"]+)"/gu)].map((match) => match[1] as TendChipId);
const css = ["styles.css", "TreeMenu.css", "buildloop.css", "Slideshow.css"]
  .map((file) => readFileSync(join(ROOT, "src/ui", file), "utf8"))
  .join("\n");

const browser = await chromium.launch();
for (const gesture of [false, true]) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const layout = tendChipLayout({ left: 820, top: 300, width: 280, height: 420 }, { width: 1920, height: 1080 }, { gesture, present });
  const sizes = Object.fromEntries(present.map((id) => [id, tendChipSize(id, gesture)]));
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}` +
      // The chips carry a 240ms position transition (they re-project as the
      // tree sways). Reading a rect mid-transition returns where the chip WAS.
      `*{transition:none !important;animation:none !important}</style></head>` +
      `<body><main class="${gesture ? "gesture-mode" : ""}">${markup}</main></body></html>`,
  );
  const rects = await page.evaluate(
    ({ layout, sizes, squeeze }) =>
      [...document.querySelectorAll<HTMLElement>("[data-chip]")].map((node) => {
        const id = node.dataset.chip!;
        const place = layout[id];
        const size = sizes[id];
        if (place !== undefined && size !== undefined) {
          node.style.left = `${place.left}px`;
          node.style.top = `${place.top}px`;
          node.style.width = `${size.width}px`;
          // The renderer's own rule (TreeMenu tendChipStyle): a squeezed chip
          // carries the ceiling the arc reserved for it.
          // `--squeeze N` forces the ceiling on the record chips, so the
          // shrink path can be checked on a surface whose arc never triggers
          // it (the mirror's graft chip).
          const ceiling = squeeze > 0 && (id === "grow" || id === "graft") ? squeeze : place.height;
          node.style.maxHeight = ceiling === undefined ? "" : `${ceiling}px`;
        }
        const box = node.getBoundingClientRect();
        // THE PRESS is the thing dwell lands on; a squeezed chip must never
        // pay for its echo out of the button.
        const press = node.querySelector<HTMLElement>(".record-steer");
        return {
          id,
          left: Math.round(box.left),
          top: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
          nominal: size?.height ?? -1,
          press: press === null ? 0 : Math.round(press.getBoundingClientRect().height),
        };
      }),
    { layout, sizes, squeeze },
  );
  if (process.argv.includes("--json")) {
    console.log(
      `${gesture ? "gesture" : "desk"}: ${JSON.stringify(Object.fromEntries(rects.map((rect) => [rect.id, rect.height])))},`,
    );
    await page.close();
    continue;
  }
  console.log(`\n=== ${gesture ? "GESTURE" : "DESK"} — grow ${armed ? "ARMED" : "idle"} @1920x1080 ===`);
  for (const rect of rects) {
    const over = rect.height - rect.nominal;
    console.log(
      `${rect.id.padEnd(15)} top=${String(rect.top).padStart(4)} h=${String(rect.height).padStart(3)}` +
        ` nominal=${String(rect.nominal).padStart(3)}${rect.press > 0 ? ` press=${rect.press}` : ""}${over > 0 ? `  OVER BY ${over}` : ""}`,
    );
  }
  for (let a = 0; a < rects.length; a += 1) {
    for (let b = a + 1; b < rects.length; b += 1) {
      const x = rects[a]!;
      const y = rects[b]!;
      if (x.left < y.left + y.width && y.left < x.left + x.width && x.top < y.top + y.height && y.top < x.top + x.height) {
        const centreIn = (inner: (typeof rects)[number], outer: (typeof rects)[number]): boolean =>
          inner.left + inner.width / 2 >= outer.left &&
          inner.left + inner.width / 2 <= outer.left + outer.width &&
          inner.top + inner.height / 2 >= outer.top &&
          inner.top + inner.height / 2 <= outer.top + outer.height;
        const covered = centreIn(x, y) ? x.id : centreIn(y, x) ? y.id : null;
        console.log(`OVERLAP ${x.id} × ${y.id}${covered !== null ? `  (${covered}'s CENTRE COVERED — dead dwell target)` : ""}`);
      }
    }
  }
  await page.close();
}
await browser.close();
