"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { useMemo } from "react";
import { useAccount, useChains } from "wagmi";
import { useAutoConnect } from "../../hooks/use-auto-connect.mjs";
import { ConnectedUserContext } from "./context.mjs";
function ConnectedUserProviderGeneral({ chainId, children }) {
  const { isConnected, connector, address, status, chain } = useAccount();
  const { isSafe } = useAutoConnect(connector);
  const configuredChains = useChains();
  const defaultChain = useMemo(
    () => {
      var _a;
      return (_a = configuredChains.find((c) => c.id === chainId)) != null ? _a : configuredChains[0];
    },
    [configuredChains, chainId]
  );
  const user = useMemo(() => {
    if (status === "connecting" && !address) {
      return { status: "LOADING" };
    }
    if (status === "disconnected" || !isConnected || !address) {
      return { status: "NOT_CONNECTED" };
    }
    const _status = (chain == null ? void 0 : chain.id) === chainId ? "CONNECTED" : "UNSUPPORTED_CHAIN";
    return {
      status: _status,
      address,
      chain: chain != null ? chain : defaultChain
    };
  }, [isConnected, address, chain, status, chainId, defaultChain]);
  const value = useMemo(() => ({ user, isSafe }), [user, isSafe]);
  return /* @__PURE__ */ jsx(ConnectedUserContext.Provider, { value, children });
}
export {
  ConnectedUserProviderGeneral
};
