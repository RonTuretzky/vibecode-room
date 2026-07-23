import {
  __objRest,
  __spreadValues
} from "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import { LOGO_DATA_URI } from "./logo-data.mjs";
function Logo(_a) {
  var _b = _a, {
    size = 32,
    className = "",
    color,
    variant,
    text,
    style
  } = _b, rest = __objRest(_b, [
    "size",
    "className",
    "color",
    "variant",
    "text",
    "style"
  ]);
  const isWhite = color === "white";
  const isSquare = variant === "square";
  const imgStyle = __spreadValues(__spreadValues(__spreadValues({}, isWhite ? { filter: "brightness(0) saturate(100%) invert(100%)" } : null), isSquare ? {
    padding: Math.round(size * 0.16),
    background: "var(--color-paper-main)",
    borderRadius: Math.max(4, Math.round(size * 0.16)),
    boxSizing: "border-box"
  } : null), style);
  const img = /* @__PURE__ */ jsx(
    "img",
    __spreadValues({
      src: LOGO_DATA_URI,
      alt: "Decentral Park",
      width: size,
      height: size,
      className,
      style: imgStyle
    }, rest)
  );
  if (text) {
    return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      img,
      /* @__PURE__ */ jsx(
        "span",
        {
          className: `text-parkDisplay-bold mt-1 ${isWhite ? "text-white" : "text-text-standard"}`,
          children: text
        }
      )
    ] });
  }
  return img;
}
export {
  Logo as default
};
