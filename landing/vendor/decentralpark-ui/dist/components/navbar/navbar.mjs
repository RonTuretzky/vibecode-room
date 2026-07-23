import "../../chunk-FWCSY2DS.mjs";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { NavSolidarityApps, NavSolidarityAppsDesktop } from "./solidarity-apps.mjs";
import { Logo } from "../Logo/index.mjs";
import { appsConfig } from "../../utils/app.mjs";
import AccountSection from "./account-section.mjs";
import { NavbarMenu } from "./navbar-menu.mjs";
function Navbar({
  app,
  children,
  className = "",
  widgetItems,
  actionItems,
  Link
}) {
  const appConfig = appsConfig[app];
  const logoColor = app === "net" ? "pine" : app === "stacks" ? "sky" : "green";
  const logoText = app === "net" ? "Commons" : app === "stacks" ? "Meetups" : "Mutual Aid";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `relative py-2.5 flex items-center justify-between ${className}`,
      children: [
        /* @__PURE__ */ jsxs(Link, { href: "/", children: [
          /* @__PURE__ */ jsx(Logo, { size: 24, color: logoColor, className: "md:hidden" }),
          /* @__PURE__ */ jsx("span", { className: "hidden md:block lg:text-2xl", children: /* @__PURE__ */ jsx(Logo, { text: "Decentral Park", size: 24, color: logoColor }) })
        ] }),
        /* @__PURE__ */ jsx(NavSolidarityAppsDesktop, { app, label: logoText }),
        /* @__PURE__ */ jsx(
          NavbarMenu,
          {
            textClassName: appConfig.text,
            mobileHeader: /* @__PURE__ */ jsx(Link, { href: "/", children: /* @__PURE__ */ jsx(Logo, { color: logoColor, text: logoText }) }),
            footer: /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx(
                NavSolidarityApps,
                {
                  showTitle: true,
                  showSelected: true,
                  rearranged: true,
                  current: app,
                  className: "mt-6 md:hidden"
                }
              ),
              /* @__PURE__ */ jsx(
                AccountSection,
                {
                  app,
                  widgetItems,
                  actionItems
                }
              )
            ] }),
            children
          }
        )
      ]
    }
  );
}
export {
  Navbar
};
