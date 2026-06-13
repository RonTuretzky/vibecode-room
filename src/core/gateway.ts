import { Gateway, type SmithersWorkflow } from "smithers-orchestrator";
import processWorkflow from "./workflows/process.tsx";

export function appGatewayUrl() {
  const host = "127.0.0.1";
  const port = Number(process.env.PANOPTICON_GATEWAY_PORT ?? 7332);

  return `http://${host}:${port}`;
}

export async function startAppGateway(opts?: { host?: string; port?: number }) {
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? Number(process.env.PANOPTICON_GATEWAY_PORT ?? 7332);
  const gateway = new Gateway({ heartbeatMs: 15000 });

  gateway.register("process", processWorkflow as SmithersWorkflow<unknown>);
  await gateway.listen({ host, port });

  return gateway;
}
