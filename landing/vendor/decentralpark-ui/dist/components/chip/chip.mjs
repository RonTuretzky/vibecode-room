import "../../chunk-FWCSY2DS.mjs";
import { jsx } from "react/jsx-runtime";
const Chip = ({
  size = "small",
  icon,
  className = "",
  children
}) => {
  let extraClass = "";
  if (size === "small") {
    if (icon) {
      extraClass = "p-2";
    } else {
      extraClass = "py-1 px-4";
    }
  } else {
    if (icon) {
      extraClass = "p-3";
    } else {
      extraClass = "py-3 px-6";
    }
  }
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: `border border-surface-ink hover:border-[#16A34A] disabled:border-surface-grey disabled:border-2 flex items-center justify-center gap-2.5 bg-paper-main ${extraClass} ${className}`,
      children
    }
  );
};
var chip_default = Chip;
export {
  chip_default as default
};
