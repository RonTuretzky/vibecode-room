"use client";
import {
  __objRest,
  __spreadProps,
  __spreadValues
} from "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import {
  useCopyToClipboard
} from "../../hooks/use-copy-to-clipboard.mjs";
import { cn } from "../../utils/index.mjs";
import { useParkUIKitContext } from "../../context/lib.mjs";
import { appsConfig } from "../../utils/app.mjs";
const CopyButtonIcon = (_a) => {
  var _b = _a, {
    children,
    textToCopy,
    checkedIconSize = 24
  } = _b, buttonProps = __objRest(_b, [
    "children",
    "textToCopy",
    "checkedIconSize"
  ]);
  const { copied, copy } = useCopyToClipboard({
    textToCopy
  });
  const app = useParkUIKitContext().app;
  return /* @__PURE__ */ jsx(
    "button",
    __spreadProps(__spreadValues({}, buttonProps), {
      onClick: copy,
      className: cn(
        buttonProps.className,
        copied ? "text-system-green!" : appsConfig[app].text
      ),
      children: copied ? /* @__PURE__ */ jsx(CheckIcon, { size: checkedIconSize, className: "" }) : /* @__PURE__ */ jsx(CopyIcon, { size: 24, className: "fill-current" })
    })
  );
};
var copy_icon_default = CopyButtonIcon;
export {
  copy_icon_default as default
};
