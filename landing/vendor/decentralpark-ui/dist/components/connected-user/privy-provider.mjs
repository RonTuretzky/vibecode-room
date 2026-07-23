"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { useMemo } from "react";
import { useChains } from "wagmi";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { ConnectedUserContext } from "./context.mjs";
function ConnectedUserProviderPrivy({
  chainId,
  children
}) {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const configuredChains = useChains();
  const defaultChain = useMemo(
    () => {
      var _a;
      return (_a = configuredChains.find((c) => c.id === chainId)) != null ? _a : configuredChains[0];
    },
    [configuredChains, chainId]
  );
  const embeddedWallet = useMemo(() => {
    return wallets.find(
      (wallet) => {
        var _a;
        return wallet.walletClientType === "privy" || wallet.walletClientType === "embedded_wallet" || ((_a = wallet.walletClientType) == null ? void 0 : _a.includes("embedded"));
      }
    );
  }, [wallets]);
  const user = useMemo(() => {
    var _a;
    if (!ready) return { status: "LOADING" };
    if (!authenticated || !(embeddedWallet == null ? void 0 : embeddedWallet.address)) {
      return { status: "NOT_CONNECTED" };
    }
    const address = embeddedWallet.address;
    const walletChainId = embeddedWallet.chainId;
    const parsedChainId = walletChainId ? parseInt(walletChainId.split(":")[1]) : void 0;
    const _status = parsedChainId === chainId ? "CONNECTED" : "UNSUPPORTED_CHAIN";
    const chain = (_a = configuredChains.find((c) => c.id === parsedChainId)) != null ? _a : defaultChain;
    return {
      status: _status,
      address,
      chain
    };
  }, [ready, authenticated, embeddedWallet, chainId, configuredChains, defaultChain]);
  const isSafe = useMemo(() => {
    return (embeddedWallet == null ? void 0 : embeddedWallet.walletClientType) === "safe" || false;
  }, [embeddedWallet]);
  const value = useMemo(() => ({ user, isSafe }), [user, isSafe]);
  return /* @__PURE__ */ jsx(ConnectedUserContext.Provider, { value, children });
}
export {
  ConnectedUserProviderPrivy
};
