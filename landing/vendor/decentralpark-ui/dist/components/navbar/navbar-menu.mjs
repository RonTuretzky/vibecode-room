"use client";
import "../../chunk-FWCSY2DS.mjs";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useRef } from "react";
import { ListIcon, XIcon } from "@phosphor-icons/react/dist/ssr";
function NavbarMenu({
  textClassName,
  mobileHeader,
  children,
  footer
}) {
  const menuRef = useRef(null);
  const toggleMenu = (close = false) => {
    var _a, _b;
    if (close) {
      (_a = menuRef.current) == null ? void 0 : _a.classList.remove("translate-x-0!");
      return;
    }
    (_b = menuRef.current) == null ? void 0 : _b.classList.toggle("translate-x-0!");
  };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        onClick: () => toggleMenu(),
        className: `ml-auto relative w-10 h-10 flex flex-col items-center justify-center space-y-1.5 focus:outline-none group md:hidden ${textClassName}`,
        "aria-label": "Toggle menu",
        children: /* @__PURE__ */ jsx(ListIcon, { size: 32 })
      }
    ),
    /* @__PURE__ */ jsxs(
      "div",
      {
        ref: menuRef,
        className: "bg-paper-main fixed overflow-y-scroll top-0 left-0 z-50 h-screen w-screen py-2.5 px-6 transition-transform translate-x-full md:static md:h-auto md:w-auto md:translate-x-0 md:py-0 md:px-0 md:flex md:items-center md:justify-end md:overflow-x-visible md:overflow-y-visible md:transition-none md:z-auto",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between mb-6 md:hidden", children: [
            mobileHeader,
            /* @__PURE__ */ jsx(
              "button",
              {
                className: `z-60 h-8 w-8 ml-auto block md:hidden ${textClassName}`,
                onClick: () => toggleMenu(true),
                children: /* @__PURE__ */ jsx(XIcon, { size: 32 })
              }
            )
          ] }),
          /* @__PURE__ */ jsx("div", { onClick: () => toggleMenu(true), children }),
          footer
        ]
      }
    )
  ] });
}
export {
  NavbarMenu
};
