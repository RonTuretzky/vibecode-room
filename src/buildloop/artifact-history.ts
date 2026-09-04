import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Keep the old version outside the served directory before starting fresh.
 * rename is atomic on this filesystem; a failed archive aborts the new build.
 * Nothing here deletes user work or automatically expires history. */
export async function archiveArtifacts(dir: string): Promise<string | null> {
  const history = join(dirname(dir), ".history", basename(dir));
  const target = join(history, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`);
  await mkdir(history, { recursive: true });
  try {
    await rename(dir, target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
