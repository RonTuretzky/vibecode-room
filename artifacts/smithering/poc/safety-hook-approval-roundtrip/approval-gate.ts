/**
 * approval-gate.ts — local HTTP approval gate for the Panopticon safety hook.
 *
 * The safety hook (hook-script.ts) blocks a Claude Code tool call by long-polling
 * this server. The voice dispatcher sends approve/deny signals here.
 *
 * Architecture:
 *   hook-script → POST /request { gateId, toolName, toolArgs, readback }
 *     → gate server holds → returns { decision: "pending" }
 *   hook-script → GET  /poll/:gateId  (long-poll, waits up to 20s)
 *     → returns { decision: "approve" | "deny" | "timeout" }
 *   voice dispatcher → POST /resolve { gateId, decision: "approve" | "deny" }
 *     → resolves the pending gate
 *
 * The dead-man timer (25s) fires in the hook script itself, not here,
 * consistent with eng §8.1 step 5 ("armed in the hook").
 *
 * POC finding: this is a plain HTTP server; production would use the Smithers
 * gateway (Hono + SSE) but the approval-gate protocol is identical.
 */

export interface PendingGate {
  gateId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  readback: string;
  createdAtMs: number;
  resolve: (decision: "approve" | "deny" | "timeout") => void;
}

export class ApprovalGateServer {
  private gates = new Map<string, PendingGate>();
  private resolutions = new Map<string, "approve" | "deny" | "timeout">();
  private readonly port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(port = 0) {
    this.port = port;
  }

  /** The actual TCP port the server is listening on (available after start()). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  /** Create a new pending approval gate. Returns gateId. */
  request(toolName: string, toolArgs: Record<string, unknown>, readback: string): { gateId: string; promise: Promise<"approve" | "deny" | "timeout"> } {
    const gateId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let resolve!: (d: "approve" | "deny" | "timeout") => void;
    const promise = new Promise<"approve" | "deny" | "timeout">((res) => { resolve = res; });

    const gate: PendingGate = {
      gateId,
      toolName,
      toolArgs,
      readback,
      createdAtMs: Date.now(),
      resolve,
    };
    this.gates.set(gateId, gate);
    return { gateId, promise };
  }

  /** Resolve a pending gate. Called by the voice dispatcher or the dead-man timer. */
  resolve(gateId: string, decision: "approve" | "deny" | "timeout"): boolean {
    const gate = this.gates.get(gateId);
    if (!gate) return false;
    this.gates.delete(gateId);
    this.resolutions.set(gateId, decision);
    gate.resolve(decision);
    return true;
  }

  /** Get all pending gates (for observability). */
  pending(): PendingGate[] {
    return Array.from(this.gates.values());
  }

  /** Start the HTTP server. Returns true if started, false if the environment cannot bind sockets. */
  start(): boolean {
    const self = this;
    try {
      this.server = Bun.serve({
        port: this.port,
        hostname: "127.0.0.1",
        fetch(req: Request) {
          return self.handleRequest(req);
        },
      });
      return true;
    } catch {
      this.server = null;
      return false;
    }
  }

  get started(): boolean {
    return this.server !== null;
  }

  stop(): void {
    this.server?.stop();
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // POST /request — hook creates an approval request
    if (req.method === "POST" && url.pathname === "/request") {
      const body = (await req.json()) as {
        toolName: string;
        toolArgs: Record<string, unknown>;
        readback: string;
      };
      const { gateId } = this.request(body.toolName, body.toolArgs, body.readback);
      return Response.json({ gateId, decision: "pending" });
    }

    // GET /poll/:gateId — hook long-polls for a decision (up to 20s)
    if (req.method === "GET" && url.pathname.startsWith("/poll/")) {
      const gateId = url.pathname.slice("/poll/".length);
      const timeoutMs = 20_000;
      const startMs = Date.now();

      while (Date.now() - startMs < timeoutMs) {
        // Check if already resolved
        const resolution = this.resolutions.get(gateId);
        if (resolution) {
          this.resolutions.delete(gateId);
          return Response.json({ decision: resolution });
        }
        // If gate no longer exists and no resolution, it was never created
        if (!this.gates.has(gateId) && !this.resolutions.has(gateId)) {
          return Response.json({ decision: "unknown" });
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return Response.json({ decision: "timeout" });
    }

    // POST /resolve — voice dispatcher sends approve/deny
    if (req.method === "POST" && url.pathname === "/resolve") {
      const body = (await req.json()) as { gateId: string; decision: "approve" | "deny" };
      const ok = this.resolve(body.gateId, body.decision);
      return Response.json({ ok, gateId: body.gateId });
    }

    // GET /pending — observability
    if (req.method === "GET" && url.pathname === "/pending") {
      const pending = this.pending().map(g => ({
        gateId: g.gateId,
        toolName: g.toolName,
        readback: g.readback,
        ageMs: Date.now() - g.createdAtMs,
      }));
      return Response.json({ pending });
    }

    return new Response("Not found", { status: 404 });
  }
}

/** Singleton for tests. */
export let testGateServer: ApprovalGateServer | null = null;

export function startTestGateServer(port = 7777): ApprovalGateServer {
  testGateServer = new ApprovalGateServer(port);
  testGateServer.start();
  return testGateServer;
}
