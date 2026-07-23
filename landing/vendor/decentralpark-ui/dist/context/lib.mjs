"use client";
import "../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { createContext, useContext } from "react";
const ParkUIKitContext = createContext(void 0);
const ParkUIKitProvider = ({
  chainId,
  tokenConfig,
  children,
  app,
  authProvider
}) => {
  return /* @__PURE__ */ jsx(ParkUIKitContext.Provider, { value: { chainId, tokenConfig, app, authProvider }, children });
};
const useParkUIKitContext = () => {
  const context = useContext(ParkUIKitContext);
  if (!context) {
    throw new Error(
      "useParkUIKitContext must be used within a ParkUIKitProvider"
    );
  }
  return context;
};
const useAuthProvider = () => {
  const context = useParkUIKitContext();
  return context.authProvider;
};
export {
  ParkUIKitContext,
  ParkUIKitProvider,
  useAuthProvider,
  useParkUIKitContext
};
