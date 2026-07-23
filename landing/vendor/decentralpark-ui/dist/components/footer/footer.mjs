import "../../chunk-FWCSY2DS.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import {
  GithubLogoIcon,
  LinkedinLogoIcon,
  InstagramLogoIcon,
  TelegramLogoIcon,
  XLogoIcon,
  EnvelopeSimpleIcon,
  ArrowUpRightIcon
} from "@phosphor-icons/react/dist/ssr";
import { LINKS } from "../../constansts/links.mjs";
import { Body } from "../typography/Typography.mjs";
import { Logo } from "../Logo/index.mjs";
import { SOLIDARITY_TOOLS } from "../../constansts/tools.mjs";
function SocialIcons({ className = "" }) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `flex items-center justify-center md:justify-start gap-5 pb-6 md:pb-0 ${className}`,
      children: [
        /* @__PURE__ */ jsx("a", { href: LINKS.twitter, className: "block", children: /* @__PURE__ */ jsx(XLogoIcon, { className: "w-6 h-6 text-surface-ink" }) }),
        /* @__PURE__ */ jsx("a", { href: LINKS.instagram, className: "block", children: /* @__PURE__ */ jsx(InstagramLogoIcon, { className: "w-6 h-6 text-surface-ink" }) }),
        /* @__PURE__ */ jsx("a", { href: LINKS.linkedin, className: "block", children: /* @__PURE__ */ jsx(LinkedinLogoIcon, { className: "w-6 h-6 text-surface-ink" }) }),
        /* @__PURE__ */ jsx(
          "a",
          {
            href: LINKS.github,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "block",
            children: /* @__PURE__ */ jsx(GithubLogoIcon, { className: "w-6 h-6 text-surface-ink" })
          }
        ),
        /* @__PURE__ */ jsx("a", { href: LINKS.telegram, className: "block", children: /* @__PURE__ */ jsx(TelegramLogoIcon, { className: "w-6 h-6 text-surface-ink" }) }),
        /* @__PURE__ */ jsx("a", { href: LINKS.newsletter, className: "block", children: /* @__PURE__ */ jsx(
          "img",
          {
            src: "/paragraph.png",
            alt: "Paragraph icon",
            width: 24,
            height: 24,
            className: "p-0.75 w-5 h-5 text-surface-ink"
          }
        ) }),
        /* @__PURE__ */ jsx("a", { href: LINKS.farcaster, className: "block", children: /* @__PURE__ */ jsx(
          "img",
          {
            src: "/farcaster-icon.png",
            alt: "Farcaster icon",
            width: 24,
            height: 24,
            className: "p-0.75 w-5 h-5 text-surface-ink"
          }
        ) })
      ]
    }
  );
}
function FooterLink({
  href,
  children,
  isExternal = false,
  mode
}) {
  const isDisabled = !href || href.trim() === "";
  if (isDisabled) {
    return /* @__PURE__ */ jsx(Body, { className: "text-surface-ink font-parkBody flex items-center gap-2 opacity-50 ", children });
  }
  return /* @__PURE__ */ jsxs(
    "a",
    {
      href,
      target: isExternal ? "_blank" : "_self",
      rel: isExternal ? "noopener noreferrer" : "",
      className: `font-parkBody flex items-center gap-2 ${mode === "colored" ? "text-surface-ink hover:text-paper-0" : ""}`,
      children: [
        children,
        isExternal && /* @__PURE__ */ jsx(ArrowUpRightIcon, { className: "w-6 h-6 text-green-0" })
      ]
    }
  );
}
function Footer({
  className = "",
  topClassName = "",
  infoClassName = "",
  mode = "colored"
}) {
  return /* @__PURE__ */ jsxs(
    "footer",
    {
      className: `px-4 py-12 ${mode === "colored" ? "bg-primary-green text-white" : "bg-transparent text-surface-ink"} ${className}`,
      children: [
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: `mb-8 max-w-79.5 mx-auto md:max-w-7xl xl:flex xl:gap-4 ${topClassName}`,
            children: [
              /* @__PURE__ */ jsxs(
                "div",
                {
                  className: `md:flex md:items-center md:justify-between md:mb-8 xl:flex-col xl:w-full xl:max-w-max ${infoClassName}`,
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-center md:items-start mb-4 md:mb-0 xl:mb-6", children: [
                      /* @__PURE__ */ jsx("div", { className: "flex uppercase text-2xl  items-center gap-3 mb-2", children: /* @__PURE__ */ jsx(
                        Logo,
                        {
                          text: "Decentral Park",
                          size: 23,
                          color: mode === "colored" ? "white" : void 0
                        }
                      ) }),
                      /* @__PURE__ */ jsx("p", { className: "font-parkBody text-center md:text-left", children: "Imagining a post-capitalist world in the heart of NYC." })
                    ] }),
                    /* @__PURE__ */ jsx("div", { className: "mb-4 xl:w-full", children: /* @__PURE__ */ jsx(SocialIcons, { className: "xl:gap-4" }) })
                  ]
                }
              ),
              /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-4 md:flex-row md:justify-between xl:w-full xl:max-w-212 xl:ml-auto", children: [
                /* @__PURE__ */ jsxs("div", { className: "w-full", children: [
                  /* @__PURE__ */ jsx(
                    Body,
                    {
                      className: `text-lg mb-4 ${mode === "transparent" ? "text-core-green" : ""}`,
                      children: "Decentral Park"
                    }
                  ),
                  /* @__PURE__ */ jsxs("ul", { className: "space-y-3", children: [
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(FooterLink, { mode, href: LINKS.about, children: "About" }) }),
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(FooterLink, { mode, href: LINKS.meetings, children: "Meetings" }) }),
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(FooterLink, { mode, href: LINKS.pastMeetups, children: "Past Meetups" }) }),
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(FooterLink, { mode, href: LINKS.partners, children: "Partners" }) })
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "w-full", children: [
                  /* @__PURE__ */ jsx(
                    Body,
                    {
                      className: `text-lg mb-4 ${mode === "transparent" ? "text-core-green" : ""}`,
                      children: "Solidarity tools"
                    }
                  ),
                  /* @__PURE__ */ jsx("ul", { className: "space-y-3", children: SOLIDARITY_TOOLS.map((tool) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
                    FooterLink,
                    {
                      href: tool.webLink || "",
                      isExternal: !tool.comingSoon,
                      children: tool.title
                    }
                  ) }, tool.id)) })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "w-full", children: [
                  /* @__PURE__ */ jsx(
                    Body,
                    {
                      className: `text-lg mb-4 ${mode === "transparent" ? "text-core-green" : ""}`,
                      children: "Reach out"
                    }
                  ),
                  /* @__PURE__ */ jsxs(
                    "a",
                    {
                      href: "mailto:nycryptoleft@gmail.com",
                      className: `font-parkBody flex items-center gap-2 ${mode === "colored" ? "text-surface-ink hover:text-paper-0" : ""}`,
                      children: [
                        /* @__PURE__ */ jsx(EnvelopeSimpleIcon, { className: "w-6 h-6 text-green-0" }),
                        "nycryptoleft@gmail.com"
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "w-full", children: [
                  /* @__PURE__ */ jsx(
                    Body,
                    {
                      className: `text-lg mb-4 ${mode === "transparent" ? "text-core-green" : ""}`,
                      children: "Support us"
                    }
                  ),
                  /* @__PURE__ */ jsxs("ul", { className: "space-y-3", children: [
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
                      FooterLink,
                      {
                        mode,
                        href: LINKS.donate,
                        isExternal: true,
                        children: "Donate in crypto"
                      }
                    ) }),
                    /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
                      FooterLink,
                      {
                        mode,
                        href: LINKS.contact,
                        isExternal: true,
                        children: "Get involved"
                      }
                    ) })
                  ] })
                ] })
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "border-t border-green-0 pt-6 flex flex-col justify-between items-center gap-4 md:flex-row md:mx-auto md:max-w-7xl", children: [
          /* @__PURE__ */ jsx(Body, { className: "text-sm", children: "Creative Commons \xA9 Decentral Park" }),
          /* @__PURE__ */ jsx("div", { className: "flex items-center gap-4", children: /* @__PURE__ */ jsx(Body, { className: "text-sm", children: "Built in the open" }) })
        ] })
      ]
    }
  );
}
export {
  Footer as default
};
