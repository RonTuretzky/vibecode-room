"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import LiftedButton from "../LiftedButton/LiftedButton.mjs";
import { ButtonShell } from "./button-shell.mjs";
import { useParkUIKitContext } from "../../context/lib.mjs";
const LoginButtonPrivy = ({
  app,
  status,
  label = "Sign In",
  rightIcon
}) => {
  const { chainId } = useParkUIKitContext();
  const className = app === "fund" ? "bg-primary-green" : app === "stacks" ? "bg-primary-sky" : "bg-primary-pine";
  const { login, ready } = usePrivy();
  const { wallets } = useWallets();
  if (status === "CONNECTED") return null;
  if (status === "LOADING" || !ready) return /* @__PURE__ */ jsx(ButtonShell, {});
  if (status === "UNSUPPORTED_CHAIN") {
    const activeWallet = wallets[0];
    return /* @__PURE__ */ jsx(
      SwitchNetwork,
      {
        activeWallet,
        chainId,
        className
      }
    );
  }
  return /* @__PURE__ */ jsx("div", { className: "[&>*]:w-full", children: /* @__PURE__ */ jsx(
    LiftedButton,
    {
      onClick: login,
      rightIcon,
      className: `w-full ${className}`,
      children: label
    }
  ) });
};
function SwitchNetwork({
  activeWallet,
  chainId,
  className
}) {
  return /* @__PURE__ */ jsx("div", { className: "[&>*]:w-full", children: /* @__PURE__ */ jsx(
    LiftedButton,
    {
      onClick: async () => {
        if (!activeWallet) return;
        try {
          await activeWallet.switchChain(chainId);
        } catch (error) {
          console.error("Failed to switch chain:", error);
        }
      },
      className: `w-full ${className}`,
      children: "Change network"
    }
  ) });
}
export {
  LoginButtonPrivy
};
