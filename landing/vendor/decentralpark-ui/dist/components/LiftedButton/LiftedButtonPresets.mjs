import "../../chunk-FWCSY2DS.mjs";
const LIFTED_BUTTON_PRESETS = {
  primary: {
    bg: "--color-primary-green",
    text: "--color-paper-main",
    hoverBg: "--color-green-1",
    hoverText: "#ffffff",
    shadowBg: "#595959"
  },
  secondary: {
    bg: "#DCFCE7",
    text: "--color-primary-green",
    hoverBg: "#F0FDF4",
    hoverText: "--color-primary-green",
    shadowBg: "#595959"
  },
  destructive: {
    bg: "--color-system-red",
    text: "--color-paper-main",
    hoverBg: "#BF0A00",
    hoverText: "#ffffff",
    shadowBg: "#595959"
  },
  positive: {
    bg: "--color-system-green",
    text: "--color-paper-main",
    hoverBg: "#15803D",
    hoverText: "#ffffff",
    shadowBg: "#595959"
  },
  stroke: {
    bg: "--color-paper-main",
    text: "--color-surface-ink",
    hoverBg: "--color-paper-2",
    hoverText: "--color-surface-ink",
    shadowBg: "#595959"
  },
  burn: {
    bg: "--color-red-0",
    text: "--color-red-main",
    hoverBg: "--color-red-1",
    hoverText: "--color-red-main",
    shadowBg: "#595959"
  }
};
function colorsToStyleVars(c) {
  return {
    ["--btn-bg"]: asCssValueWithFallback(c.bg),
    ["--btn-text"]: asCssValueWithFallback(c.text),
    ["--btn-hover-bg"]: asCssValueWithFallback(c.hoverBg),
    ["--btn-hover-text"]: asCssValueWithFallback(c.hoverText),
    ["--btn-shadow"]: asCssValueWithFallback(c.shadowBg)
  };
}
const CSS_VAR_FALLBACKS = {
  "--color-primary-green": "#16a34a",
  "--color-paper-main": "#f0fdf4",
  "--color-surface-ink": "#14211a",
  "--color-system-red": "#df0b00",
  "--color-system-green": "#16a34a",
  "--color-green-1": "#15803d",
  "--color-paper-2": "#bbf7d0",
  "--color-red-0": "#f7cac2",
  "--color-red-1": "#f4b8ad",
  "--color-red-main": "#df0b00"
};
function asCssValueWithFallback(v) {
  if (!v) return "";
  if (v.includes("var(")) return v;
  if (v.startsWith("--")) {
    const fallback = CSS_VAR_FALLBACKS[v] || "#000000";
    return `var(${v}, ${fallback})`;
  }
  return v;
}
export {
  LIFTED_BUTTON_PRESETS,
  colorsToStyleVars
};
