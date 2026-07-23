"use client";
import {
  __spreadProps,
  __spreadValues
} from "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { ConnectButton, useChainModal } from "@rainbow-me/rainbowkit";
import LiftedButton from "../LiftedButton/LiftedButton.mjs";
import { ButtonShell } from "./button-shell.mjs";
const LoginButtonGeneral = ({
  app,
  status,
  label = "Sign In",
  rightIcon
}) => {
  const className = app === "fund" ? "bg-primary-green" : app === "stacks" ? "bg-primary-sky" : "bg-primary-pine";
  const { openChainModal } = useChainModal();
  if (status === "CONNECTED") return null;
  if (status === "LOADING") return /* @__PURE__ */ jsx(ButtonShell, {});
  if (status === "UNSUPPORTED_CHAIN") {
    return /* @__PURE__ */ jsx("div", { className: "[&>*]:w-full", children: /* @__PURE__ */ jsx(
      LiftedButton,
      {
        onClick: () => openChainModal == null ? void 0 : openChainModal(),
        className: `w-full ${className}`,
        children: "Change network"
      }
    ) });
  }
  return /* @__PURE__ */ jsx(
    CustomLoginButton,
    {
      label,
      rightIcon,
      className
    }
  );
};
function CustomLoginButton({
  className,
  label = "Sign In",
  rightIcon
}) {
  return /* @__PURE__ */ jsx(ConnectButton.Custom, { children: ({
    account,
    chain,
    openConnectModal,
    authenticationStatus,
    mounted
  }) => {
    const ready = mounted && authenticationStatus !== "loading";
    const connected = ready && account && chain && (!authenticationStatus || authenticationStatus === "authenticated");
    if (connected) return null;
    return /* @__PURE__ */ jsx(
      "div",
      __spreadProps(__spreadValues({}, !ready && {
        "aria-hidden": true,
        style: {
          opacity: 0,
          pointerEvents: "none",
          userSelect: "none"
        }
      }), {
        className: "[&>*]:w-full",
        children: /* @__PURE__ */ jsx(
          LiftedButton,
          {
            onClick: openConnectModal,
            rightIcon,
            className: `w-full ${className}`,
            children: label
          }
        )
      })
    );
  } });
}
export {
  LoginButtonGeneral
};
