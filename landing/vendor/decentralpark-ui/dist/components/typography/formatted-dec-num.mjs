import "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import { cn } from "../../utils/index.mjs";
import { formatBalance } from "../../utils/formatter.mjs";
import { Logo } from "../Logo/index.mjs";
import { Body } from "./Typography.mjs";
function FormattedDecimalNumber({
  value,
  className,
  integralPartClassName,
  decimalPartClassName,
  withParkIcon,
  parkIconClassName,
  parkSize = 24,
  unit = ""
}) {
  const parsedValue = typeof value === "number" ? value : parseFloat(value);
  const formattedValue = formatBalance(parsedValue, 2);
  const [integerPart, decimalPart] = formattedValue.split(".");
  return /* @__PURE__ */ jsxs("div", { className: "inline-flex items-center justify-start gap-2", children: [
    withParkIcon && /* @__PURE__ */ jsx(Logo, { className: parkIconClassName, size: parkSize }),
    /* @__PURE__ */ jsxs(
      Body,
      {
        bold: true,
        className: cn(withParkIcon && "mt-[0.2rem]", className),
        children: [
          /* @__PURE__ */ jsx("span", { className: cn("text-base", integralPartClassName), children: `${unit}${integerPart}`.trim() }),
          /* @__PURE__ */ jsxs("span", { className: cn("text-xs", decimalPartClassName), children: [
            ".",
            decimalPart
          ] })
        ]
      }
    )
  ] });
}
export {
  FormattedDecimalNumber
};
