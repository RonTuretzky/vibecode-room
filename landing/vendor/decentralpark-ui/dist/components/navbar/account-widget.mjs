"use client";
import "../../chunk-FWCSY2DS.mjs";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import {
  ArrowUpRightIcon,
  GraphIcon,
  UserCircleIcon,
  WalletIcon
} from "@phosphor-icons/react";
import clsx from "clsx";
import { Body } from "../typography/Typography.mjs";
import { truncateAddress } from "../../utils/truncate-address.mjs";
import { Logo } from "../Logo/index.mjs";
import LogoutButton from "./log-out.mjs";
import { appsConfig } from "../../utils/app.mjs";
import { useParkBalance } from "../../hooks/use-park-balance.mjs";
import NavAccountWidgetItem from "./account-widget-item.mjs";
import { FormattedDecimalNumber } from "../typography/formatted-dec-num.mjs";
import { CopyButtonIcon } from "../buttons/index.mjs";
import { useConnectedUser } from "../connected-user/index.mjs";
const chainsIcon = {
  100: "/gnosis_icon.svg"
};
const NavAccountDetails = ({
  className,
  userAddress,
  ensNameResult,
  app,
  widgetItems,
  actionItems
}) => {
  var _a, _b, _c;
  const { PARK } = useParkBalance({ address: userAddress });
  const { user } = useConnectedUser();
  const appIconColor = appsConfig[app].text;
  const chain = user.status === "CONNECTED" || user.status === "UNSUPPORTED_CHAIN" ? user.chain : void 0;
  const blockExplorerUrl = (_b = (_a = chain == null ? void 0 : chain.blockExplorers) == null ? void 0 : _a.default.url) != null ? _b : "https://gnosisscan.io";
  const scanLink = `${blockExplorerUrl}/address/`;
  const chainName = (_c = chain == null ? void 0 : chain.name) != null ? _c : "Unknown";
  const chainIcon = chain ? chainsIcon[chain.id] : void 0;
  return /* @__PURE__ */ jsxs(
    "section",
    {
      className: clsx(
        "bg-paper-2 p-5 flex flex-col gap-4 w-full max-w-md",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs(
          NavAccountWidgetItem,
          {
            I: UserCircleIcon,
            appIconColor,
            label: ensNameResult.data || truncateAddress(userAddress || ""),
            children: [
              /* @__PURE__ */ jsx(
                CopyButtonIcon,
                {
                  textToCopy: ensNameResult.data || userAddress
                }
              ),
              /* @__PURE__ */ jsx(
                "a",
                {
                  href: scanLink + (userAddress || ""),
                  className: "text-surface-grey",
                  target: "_blank",
                  rel: "noopener noreferrer",
                  children: /* @__PURE__ */ jsx(ArrowUpRightIcon, { size: 24 })
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsx(
          NavAccountWidgetItem,
          {
            I: WalletIcon,
            appIconColor,
            label: "Park Balance",
            children: /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx(Logo, { size: 24 }),
              /* @__PURE__ */ jsx(Body, { children: /* @__PURE__ */ jsx(FormattedDecimalNumber, { value: PARK }) })
            ] })
          }
        ),
        widgetItems,
        /* @__PURE__ */ jsx(
          NavAccountWidgetItem,
          {
            I: GraphIcon,
            appIconColor,
            label: "Network",
            children: /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-center", children: [
              chainIcon && /* @__PURE__ */ jsx(
                "img",
                {
                  src: chainIcon,
                  alt: "",
                  width: 24,
                  height: 24,
                  className: "mr-2"
                }
              ),
              /* @__PURE__ */ jsx(Body, { className: "font-bold", children: chainName })
            ] })
          }
        ),
        actionItems,
        /* @__PURE__ */ jsx(LogoutButton, { className: "mt-1" })
      ]
    }
  );
};
var account_widget_default = NavAccountDetails;
export {
  account_widget_default as default
};
