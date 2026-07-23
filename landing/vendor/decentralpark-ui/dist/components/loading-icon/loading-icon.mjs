import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
import { cn } from "../../utils/index.mjs";
function LoadingIcon({
  app,
  className
}) {
  const strokeColor = app === "fund" ? "stroke-primary-green" : app === "stacks" ? "stroke-primary-sky" : "stroke-primary-pine";
  return /* @__PURE__ */ jsx("div", { className: cn("relative w-8 h-8", className), children: /* @__PURE__ */ jsx(
    "svg",
    {
      className: "w-full h-full animate-spin origin-center",
      viewBox: "0 0 40 40",
      fill: "none",
      style: { animationDuration: "2s" },
      children: /* @__PURE__ */ jsx(
        "circle",
        {
          cx: "20",
          cy: "20",
          r: "17.5",
          fill: "none",
          strokeWidth: "3",
          strokeLinecap: "round",
          strokeDasharray: "4.2 4.6",
          className: strokeColor
        }
      )
    }
  ) });
}
export {
  LoadingIcon
};
