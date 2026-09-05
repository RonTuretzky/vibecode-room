import { spawn } from "node:child_process";
// Drain both pipes immediately, bound retained output, and kill the process
// group on cancellation/timeout so build children do not outlive their job.
export function runCommand(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
  env = process.env,
  timeoutMs = 180_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let diagnostics = "";
    let failure: string | null = null;
    const stop = (reason: string) => {
      failure = reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => stop("Cancelled");
    const timer = setTimeout(
      () => stop(`Timed out after ${timeoutMs / 1000}s: ${argv[0]}`),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    const append = (chunk: string) => {
      if (output.length + chunk.length > 2_000_000) {
        stop("Command output exceeded 2 million characters");
        return;
      }
      output += chunk;
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", append);
    child.stderr!.on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-64_000);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (failure || code !== 0)
        reject(
          new Error(
            failure ??
              `${argv[0]} exited with code ${code}: ${(diagnostics || output).slice(-4000)}`,
          ),
        );
      else resolve(output);
    });
  });
}
