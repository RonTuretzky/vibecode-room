"use client";
import {
  __objRest,
  __spreadProps,
  __spreadValues
} from "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import React from "react";
import {
  LIFTED_BUTTON_PRESETS,
  colorsToStyleVars
} from "./LiftedButtonPresets.mjs";
import { validateCSSVariables } from "../../utils/cssValidation.mjs";
const cloneWithClasses = (element, additionalClasses) => {
  if (React.isValidElement(element)) {
    const existingClassName = element.props.className || "";
    const newClassName = `${existingClassName} ${additionalClasses}`.trim();
    return React.cloneElement(element, {
      className: newClassName
    });
  }
  return element;
};
function LiftedButton(_a) {
  var _b = _a, {
    children,
    leftIcon,
    rightIcon,
    disabled = false,
    preset = "primary",
    colorOverrides = {},
    offsetPx = 4,
    durationMs = 300,
    className = "",
    type = "button",
    width = "auto",
    scrollTo
  } = _b, rest = __objRest(_b, [
    "children",
    "leftIcon",
    "rightIcon",
    "disabled",
    "preset",
    "colorOverrides",
    "offsetPx",
    "durationMs",
    "className",
    "type",
    "width",
    "scrollTo"
  ]);
  React.useEffect(() => {
    validateCSSVariables();
  }, []);
  const base = LIFTED_BUTTON_PRESETS[preset];
  const mergedColors = __spreadValues(__spreadValues({}, base), colorOverrides);
  const styleVars = __spreadProps(__spreadValues({}, colorsToStyleVars(mergedColors)), {
    ["--btn-offset"]: `${offsetPx}px`,
    ["--btn-duration"]: `${durationMs}ms`
  });
  const baseClassNames = [
    "lifted-button-base",
    width === "full" ? "w-full" : "",
    width === "mobile-full" ? "w-full xl:w-auto" : ""
  ];
  const getPresetClass = () => {
    return "lifted-button";
  };
  const activeClassNames = [
    getPresetClass(),
    // motion
    "lifted-button-motion",
    // lifted offset
    "lifted-button-lifted",
    // depress to base on active
    "lifted-button-active"
  ];
  const disabledClassNames = ["lifted-button-disabled"];
  const classNames = baseClassNames.concat(
    disabled ? disabledClassNames : activeClassNames
  );
  classNames.push(className);
  const handleClick = (e) => {
    var _a2;
    if (scrollTo) {
      e.preventDefault();
      (_a2 = document.getElementById(scrollTo)) == null ? void 0 : _a2.scrollIntoView({
        behavior: "smooth"
      });
    }
    if (rest.onClick) {
      rest.onClick(e);
    }
  };
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: [
        width === "full" ? "relative block select-none align-middle" : width === "mobile-full" ? "relative block md:inline-block select-none align-middle" : "relative inline-block select-none align-middle",
        "group"
        // allows us to inherit hover activity on this parent in the children
      ].join(" "),
      style: styleVars,
      children: [
        disabled ? null : /* @__PURE__ */ jsx(
          "span",
          {
            "aria-hidden": true,
            className: "lifted-button-shadow",
            style: {
              transform: `translateX(2px) translateY(2px)`
            }
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          __spreadProps(__spreadValues({
            type,
            className: classNames.join(" "),
            onClick: handleClick
          }, rest), {
            children: [
              leftIcon ? /* @__PURE__ */ jsx(
                "span",
                {
                  className: "shrink-0 py-[5px] flex items-center justify-center",
                  "aria-hidden": true,
                  children: cloneWithClasses(leftIcon, "w-6 h-6")
                }
              ) : null,
              /* @__PURE__ */ jsx("span", { className: "whitespace-nowrap mt-1 leading-none p-[5px]", children }),
              rightIcon ? /* @__PURE__ */ jsx(
                "span",
                {
                  className: "shrink-0 py-[5px] flex items-center justify-center",
                  "aria-hidden": true,
                  children: cloneWithClasses(rightIcon, "w-6 h-6")
                }
              ) : null
            ]
          })
        )
      ]
    }
  );
}
export {
  LiftedButton as default
};
