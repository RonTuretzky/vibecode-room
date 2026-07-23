"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { SignOutIcon } from "@phosphor-icons/react";
import clsx from "clsx";
import { useDisconnect } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import LiftedButton from "../LiftedButton/LiftedButton.mjs";
import { useAuthProvider } from "../../context/lib.mjs";
const LogoutButton = ({ className }) => {
  const authProvider = useAuthProvider();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { logout: privyLogout } = usePrivy();
  const handleLogout = () => {
    if (authProvider === "privy") {
      privyLogout();
    } else {
      wagmiDisconnect();
    }
  };
  return /* @__PURE__ */ jsx("div", { className: clsx("lifted-button-container", className), children: /* @__PURE__ */ jsx(
    LiftedButton,
    {
      preset: "burn",
      rightIcon: /* @__PURE__ */ jsx(SignOutIcon, {}),
      onClick: handleLogout,
      children: "Sign out"
    }
  ) });
};
var log_out_default = LogoutButton;
export {
  log_out_default as default
};
