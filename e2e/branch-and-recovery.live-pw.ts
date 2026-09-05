import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { startBranchRig } from "./branch-rig";
import { startRoom } from "../src/testing/room-harness";
import { openProjectWork } from "./project-workspace";

test("the visible Plant action places a spoken idea and opens its generated concept", async ({
  page,
  context,
}) => {
  const rig = await startBranchRig(resolve("."));
  const room = await startRoom({ seedDemoFleet: false, env: rig.env });
  try {
    await page.goto(room.baseUrl);
    await room.speak({
      utterances: [
        {
          text: "we should build a garden dashboard that shows every blocked task",
        },
      ],
    });
    await page.getByTestId("idea-plant-button").first().click();
    await expect(page.getByTestId("planting-hint")).toBeVisible();
    const canvas = page.getByTestId("room-scene");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    await canvas.click({
      position: { x: box.width * 0.52, y: box.height * 0.69 },
    });
    const project = (
      await room.waitFor(
        (snapshot) =>
          snapshot.processes.find(
            (process) =>
              process.previewUrl && snapshot.plantedPositions?.[process.upid],
          ),
        { label: "planted concept", timeoutMs: 30_000 },
      )
    ).value;
    expect((await room.state()).processes).toHaveLength(1);
    await openProjectWork(page, project.callsign);
    await expect(
      page.getByRole("heading", { name: /Concept ready/ }),
    ).toBeVisible();
    const preview = await context.newPage();
    await preview.goto(project.previewUrl!);
    await expect(preview.locator("body")).toContainText(/garden|dashboard/i);
    await preview.close();
  } finally {
    await room.stop();
    await rig.stop();
  }
});

test("plant, implement a branch, graft, cancel, and recover in a second room session", async ({
  page,
  context,
}) => {
  // Whole-journey allowance includes two room boots and many browser actions.
  // Individual job/placement readiness deadlines remain separately bounded.
  test.setTimeout(300_000);
  const rig = await startBranchRig(resolve("."));
  let room = await startRoom({ seedDemoFleet: false, env: rig.env });
  try {
    await page.goto(room.baseUrl);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Repository or reference URL" })
      .fill(rig.url);
    await page.getByRole("button", { name: "Add to garden" }).click();
    const project = (
      await room.waitFor(
        (snapshot) =>
          snapshot.processes.find((process) => process.treeRepo?.adopted),
        { label: "import studied" },
      )
    ).value;
    await openProjectWork(page, project.callsign);
    await page.getByRole("button", { name: "Show in garden" }).click();
    await page.getByTestId("tree-menu-replant").click();
    await expect(page.getByTestId("planting-hint")).toBeVisible();
    const canvas = page.getByTestId("room-scene");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    await canvas.click({
      position: { x: box.width * 0.52, y: box.height * 0.69 },
    });
    const point = (
      await room.waitFor(
        (snapshot) => snapshot.plantedPositions?.[project.upid],
        { label: "shared placement" },
      )
    ).value;
    const second = await context.newPage();
    await second.goto(room.baseUrl);
    await expect
      .poll(async () =>
        second.evaluate(
          () => window.__VIBERSYN__?.getSnapshot()?.plantedPositions,
        ),
      )
      .toEqual({ [project.upid]: point });
    await second.close();
    await openProjectWork(page, project.callsign);
    await page
      .getByRole("textbox", { name: "Describe the change" })
      .fill("Add a dark mode toggle");
    await page.getByRole("button", { name: "Grow branch with change" }).click();
    const grown = (
      await room.waitFor(
        (snapshot) =>
          snapshot.branchJobs?.find((job) => job.status === "ready"),
        { label: "implemented branch", timeoutMs: 25_000 },
      )
    ).value;
    expect(grown.files).toContain("index.html");
    const preview = await context.newPage();
    await preview.goto(grown.previewUrl!);
    await preview.getByRole("button", { name: "Dark mode" }).click();
    await expect(preview.locator("body")).toHaveAttribute("data-theme", "dark");
    await expect(preview.locator("body")).toHaveCSS(
      "background-color",
      "rgb(23, 33, 43)",
    );
    await preview.close();
    await page
      .getByRole("combobox", { name: "Change target" })
      .selectOption(grown.branch);
    await page
      .getByRole("textbox", { name: "Describe the change" })
      .fill("Add a reset theme button");
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    const grafted = (
      await room.waitFor(
        (snapshot) =>
          snapshot.branchJobs?.find(
            (job) => job.id !== grown.id && job.status === "ready",
          ),
        { label: "graft implemented" },
      )
    ).value;
    const graft = await context.newPage();
    await graft.goto(grafted.previewUrl!);
    await graft.getByRole("button", { name: "Dark mode" }).click();
    await graft.getByRole("button", { name: "Reset theme" }).click();
    await expect(graft.locator("body")).not.toHaveAttribute("data-theme");
    await expect(graft.locator("body")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await graft.close();
    await page
      .getByRole("textbox", { name: "Describe the change" })
      .fill("cancel this slow change");
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await room.waitFor(
      (snapshot) =>
        snapshot.branchJobs?.find((job) => job.status === "implementing"),
      { label: "running cancellable job" },
    );
    await page
      .getByRole("button", { name: "Cancel change", exact: true })
      .click();
    await room.waitFor(
      (snapshot) =>
        snapshot.branchJobs?.some((job) => job.status === "cancelled"),
      { label: "cancelled" },
    );
    await page
      .getByRole("textbox", { name: "Describe the change" })
      .fill("fail this change");
    await page
      .getByRole("button", { name: "Apply change", exact: true })
      .click();
    await expect(
      page.getByText(/Intentional fixture failure/).first(),
    ).toBeVisible();
    await page
      .locator("#project-workspace")
      .getByTestId("record-steer-start")
      .click();
    await page.getByRole("button", { name: "Close projects" }).click();
    await expect(
      page.getByRole("complementary", { name: "Active recording" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel recording" }).click();
    await room.waitFor((snapshot) => !snapshot.steeringUpid, {
      label: "recording cancelled",
    });
    const ids = (await room.state()).branchJobs!.map((job) => job.id);
    await room.stop();
    room = await startRoom({ seedDemoFleet: false, env: rig.env });
    await page.goto(room.baseUrl);
    await openProjectWork(page, project.callsign);
    const restored = await room.state();
    expect(restored.recovery?.error).toBeNull();
    expect(restored.plantedPositions?.[project.upid]).toEqual(point);
    expect(restored.branchJobs!.map((job) => job.id)).toEqual(ids);
    const lastPreview = restored.branchJobs!.find(
      (job) => job.id === grafted.id,
    )!.previewUrl!;
    const after = await context.newPage();
    await after.goto(lastPreview);
    await expect(
      after.getByRole("button", { name: "Reset theme" }),
    ).toBeVisible();
    await after.close();
  } finally {
    await room.stop();
    await rig.stop();
  }
});
