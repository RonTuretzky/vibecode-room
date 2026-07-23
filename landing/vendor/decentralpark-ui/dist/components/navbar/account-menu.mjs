"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { Body } from "../typography/Typography.mjs";
import { truncateAddress } from "../../utils/truncate-address.mjs";
import { CaretDownIcon } from "@phosphor-icons/react";
import NavAccountDetails from "./account-widget.mjs";
import { appsConfig } from "../../utils/app.mjs";
const AccountMenu = ({
  userAddress,
  ensNameResult,
  app,
  widgetItems,
  actionItems
}) => {
  return /* @__PURE__ */ jsxs(NavigationMenu.Root, { className: "relative", children: [
    /* @__PURE__ */ jsx(NavigationMenu.List, { children: /* @__PURE__ */ jsxs(NavigationMenu.Item, { children: [
      /* @__PURE__ */ jsx(NavigationMenu.Trigger, { className: "group w-full", children: /* @__PURE__ */ jsxs(
        Body,
        {
          bold: true,
          className: "w-full flex items-center justify-center gap-2.5 truncate text-ellipsis py-3 px-6 bg-paper-2 border border-surface-ink font-bold",
          children: [
            ensNameResult.data || truncateAddress(userAddress || ""),
            /* @__PURE__ */ jsx("span", { className: appsConfig[app].text, children: /* @__PURE__ */ jsx(CaretDownIcon, {}) })
          ]
        }
      ) }),
      /* @__PURE__ */ jsx(NavigationMenu.Content, { className: "w-max", children: /* @__PURE__ */ jsx(
        NavAccountDetails,
        {
          className: "border w-full md:w-screen md:max-w-110.75 md:bg-paper-main md:border-paper-2",
          userAddress,
          ensNameResult,
          app,
          widgetItems,
          actionItems
        }
      ) })
    ] }) }),
    /* @__PURE__ */ jsx(NavigationMenu.Viewport, { className: "nav-account-menu absolute top-14 right-0 z-20 left-0 md:left-auto" })
  ] });
};
var account_menu_default = AccountMenu;
export {
  account_menu_default as default
};
