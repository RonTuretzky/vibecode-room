import { expect, test } from "bun:test";
import { runCommand } from "./run-command";

test("CLI diagnostics do not corrupt structured stdout", async () => {
  const output = await runCommand(
    ["sh", "-c", 'echo diagnostic >&2; echo \'{"result":"ready"}\''],
    process.cwd(),
    new AbortController().signal,
  );
  expect(JSON.parse(output)).toEqual({ result: "ready" });
});

test("an already cancelled command cannot start", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCommand(["missing-executable"], process.cwd(), controller.signal),
  ).rejects.toThrow("Cancelled");
});

test("large generated source survives stdout chunk boundaries", async () => {
  const output = await runCommand([process.execPath, "-e", "process.stdout.write(JSON.stringify({text:'é'.repeat(100000)}))"], process.cwd(), new AbortController().signal);
  expect(JSON.parse(output).text).toBe("é".repeat(100000));
});
