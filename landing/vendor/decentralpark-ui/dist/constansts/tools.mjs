import "../chunk-FWCSY2DS.mjs";
import { LINKS } from "./links.mjs";
const SOLIDARITY_TOOLS = [
  {
    id: "mutual-aid",
    title: "Mutual Aid",
    shortDescription: "Give without giving",
    description: "Pool resources to fund grassroots projects and mutual aid across NYC. Support what matters to the collective.",
    color: "green",
    buttonClass: "bg-primary-green text-white",
    webLink: LINKS.solidarityFund,
    comingSoon: false
  },
  {
    id: "meetups",
    title: "Meetups",
    shortDescription: "Gather in the park.",
    description: "Regular meetups to imagine and build a post-capitalist world together.",
    color: "sky",
    buttonClass: "",
    colorOverrides: {
      bg: "--color-primary-sky",
      hoverBg: "--color-sky-2"
    },
    webLink: LINKS.meetings,
    comingSoon: false
  },
  {
    id: "commons",
    title: "Commons",
    shortDescription: "Build together.",
    description: "Open tools and shared infrastructure that put people and planet over profit.",
    color: "pine",
    buttonClass: "",
    colorOverrides: {
      bg: "--color-primary-pine",
      hoverBg: "--color-pine-2"
    },
    comingSoon: true
  }
];
function getSolidarityToolsByIds(ids) {
  return SOLIDARITY_TOOLS.filter((tool) => ids.includes(tool.id));
}
function getVisibleSolidarityTools(hiddenIds = []) {
  return SOLIDARITY_TOOLS.filter((tool) => !hiddenIds.includes(tool.id));
}
export {
  SOLIDARITY_TOOLS,
  getSolidarityToolsByIds,
  getVisibleSolidarityTools
};
