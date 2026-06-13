import { Gateway, type SmithersWorkflow } from "smithers-orchestrator";
import processWorkflow from "./workflows/process.tsx";

type AppGatewayEndpoint = {
  host: string;
  port: number;
};

function defaultAppGatewayEndpoint(): AppGatewayEndpoint {
  return {
    host: "127.0.0.1",
    port: Number(process.env.PANOPTICON_GATEWAY_PORT ?? 7332),
  };
}

let currentEndpoint = defaultAppGatewayEndpoint();

function formatHostForUrl(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function appGatewayUrl() {
  return `http://${formatHostForUrl(currentEndpoint.host)}:${currentEndpoint.port}`;
}

export async function startAppGateway(opts?: { host?: string; port?: number }) {
  const defaults = defaultAppGatewayEndpoint();
  const host = opts?.host ?? defaults.host;
  const port = opts?.port ?? defaults.port;
  const gateway = new Gateway({ heartbeatMs: 15000 });

  gateway.register("process", processWorkflow as SmithersWorkflow<unknown>);
  const server = await gateway.listen({ host, port });
  const address = server.address();
  currentEndpoint = {
    host,
    port: typeof address === "object" && address !== null ? address.port : port,
  };

  return gateway;
}
