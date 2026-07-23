"use client";
import "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import clsx from "clsx";
import { Body } from "../typography/Typography.mjs";
const NavAccountWidgetItem = ({
  I,
  label,
  children,
  appIconColor
}) => {
  return /* @__PURE__ */ jsxs("li", { className: clsx("flex items-center justify-start gap-2"), children: [
    /* @__PURE__ */ jsx(I, { size: 24, className: appIconColor }),
    /* @__PURE__ */ jsx(Body, { className: "mr-auto ml-2", children: label }),
    /* @__PURE__ */ jsx("div", { className: "flex items-center justify-center gap-2", children })
  ] });
};
var account_widget_item_default = NavAccountWidgetItem;
export {
  account_widget_item_default as default
};
