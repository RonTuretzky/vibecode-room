import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

// Snapshot publication only writes when durable data changes. Atomic replace
// keeps a killed process from leaving half JSON; unreadable state is preserved.
export class RoomStateFile<T> {
  error: string | null = null;
  #last = "";
  constructor(
    readonly path: string | null,
    readonly validate: (value: unknown) => boolean,
  ) {}
  read(): T | null {
    if (!this.path) return null;
    try {
      if (statSync(this.path).size > 16_000_000)
        throw new Error("state file exceeds 16 MB");
      const raw = readFileSync(this.path, "utf8");
      const data: unknown = JSON.parse(raw);
      if (!this.validate(data))
        throw new Error("unsupported or malformed room state");
      this.#last = raw;
      return data as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = `Recovery failed: ${String(error)}. Saved file left untouched: ${this.path}`;
      return null;
    }
  }
  write(value: T): void {
    if (!this.path || this.error) return;
    const raw = JSON.stringify(value);
    if (raw === this.#last) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, raw, { mode: 0o600 });
      renameSync(temp, this.path);
      this.#last = raw;
    } catch (error) {
      this.error = `Room state could not be saved: ${String(error)}`;
    }
  }
}
