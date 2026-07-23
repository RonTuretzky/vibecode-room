"use client";
import "../../chunk-FWCSY2DS.mjs";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { LINKS } from "../../constansts/links.mjs";
import { appsConfig } from "../../utils/app.mjs";
import { Body, Caption } from "../typography/Typography.mjs";
import { Logo } from "../Logo/index.mjs";
const _apps = [
  {
    id: "fund",
    label: "Mutual Aid",
    desc: "Give without giving.",
    color: "text-[#16A34A]",
    comingSoon: false,
    webLink: LINKS.solidarityFund
  },
  {
    id: "stacks",
    label: "Meetups",
    desc: "Gather in the park.",
    color: "text-[#0284C7]",
    comingSoon: false,
    webLink: LINKS.stacks
  },
  {
    id: "net",
    label: "Commons",
    desc: "Build together.",
    color: "text-[#0D9488]",
    comingSoon: true
  }
];
const AppPageContent = ({
  app,
  selected,
  appConfig
}) => {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: `mr-2 ${app.color}`, children: /* @__PURE__ */ jsx(AppSvg, {}) }),
    /* @__PURE__ */ jsxs("div", { className: "mr-auto", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-start font-bold", children: [
        /* @__PURE__ */ jsx(Body, { children: app.label }),
        app.comingSoon && /* @__PURE__ */ jsx(Caption, { className: `text-xs ml-2 ${appConfig.text}`, children: "Coming soon" })
      ] }),
      /* @__PURE__ */ jsx(Body, { className: "font-light text-surface-grey-2", children: app.desc })
    ] }),
    selected && /* @__PURE__ */ jsx(Caption, { className: "font-bold text-system-green", children: "Selected" })
  ] });
};
const NavSolidarityApps = ({
  current = "stacks",
  className = "",
  showTitle,
  showSelected,
  rearranged
}) => {
  const apps = rearranged ? [..._apps].sort((a, b) => {
    if (a.id === current) return -1;
    if (b.id === current) return 1;
    return 0;
  }) : [..._apps];
  const appConfig = appsConfig[current];
  return /* @__PURE__ */ jsxs("section", { className, children: [
    showTitle && /* @__PURE__ */ jsx(Body, { className: "text-surface-grey mb-4", children: "Solidarity apps" }),
    /* @__PURE__ */ jsx("ul", { className: "flex flex-col gap-2", children: [...apps].map((app) => {
      const isLink = !app.comingSoon && app.webLink && current !== app.id;
      return /* @__PURE__ */ jsx(
        "li",
        {
          className: `${isLink ? "" : `flex items-center justify-start p-2.5 border ${current === app.id ? appConfig.border : "border-transparent"}`}`,
          children: isLink ? /* @__PURE__ */ jsx(
            "a",
            {
              href: app.webLink,
              className: "flex items-center justify-start p-2.5 border border-transparent",
              children: /* @__PURE__ */ jsx(
                AppPageContent,
                {
                  app,
                  selected: showSelected && current === app.id,
                  appConfig
                }
              )
            }
          ) : /* @__PURE__ */ jsx(
            AppPageContent,
            {
              app,
              selected: showSelected && current === app.id,
              appConfig
            }
          )
        },
        app.id
      );
    }) })
  ] });
};
const NavSolidarityAppsDesktop = ({
  label,
  app
}) => {
  const appConfig = appsConfig[app];
  return /* @__PURE__ */ jsxs(NavigationMenu.Root, { className: "hidden md:block md:mr-auto md:ml-2 relative", children: [
    /* @__PURE__ */ jsx(NavigationMenu.List, { children: /* @__PURE__ */ jsxs(NavigationMenu.Item, { children: [
      /* @__PURE__ */ jsx(NavigationMenu.Trigger, { className: "group", children: /* @__PURE__ */ jsxs(Body, { className: "md:text-surface-grey-2 md:inline-flex md:items-center md:justify-center md:gap-2 lg:text-2xl lg:mt-1", children: [
        /* @__PURE__ */ jsx("span", { className: "capitalize", children: label }),
        /* @__PURE__ */ jsx(
          "span",
          {
            className: `transition-transform duration-300 group-data-[state=open]:rotate-180 md:mt-[-0.0625rem] lg:-mt-1 ${appConfig.text}`,
            children: /* @__PURE__ */ jsx(Caret, {})
          }
        )
      ] }) }),
      /* @__PURE__ */ jsx(NavigationMenu.Content, { className: "w-80", children: /* @__PURE__ */ jsx("div", { className: "bg-paper-main border border-paper-2 overflow-hidden", children: /* @__PURE__ */ jsx(
        NavSolidarityApps,
        {
          current: app,
          className: "py-6 px-8"
        }
      ) }) })
    ] }) }),
    /* @__PURE__ */ jsx(NavigationMenu.Viewport, { className: "absolute left-0 top-full mt-2 z-50" })
  ] });
};
const AppSvg = () => /* @__PURE__ */ jsx(Logo, { size: 32 });
const Caret = () => /* @__PURE__ */ jsx(
  "svg",
  {
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ jsx(
      "path",
      {
        d: "M19.5 9L12 16.5L4.5 9",
        stroke: "currentcolor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  }
);
export {
  NavSolidarityApps,
  NavSolidarityAppsDesktop
};
