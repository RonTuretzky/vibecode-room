// A tuned SNES-era palette: saturated but slightly chalky, like Secret of Mana /
// A Link to the Past. Hex strings for CSS, numbers for three materials.

export const PAL = {
  grassLight: "#6fcf76",
  grassDark: "#3fa34d",
  grassEdge: "#2c7d3a",
  water: "#3f8be0",
  waterDeep: "#2b5fb0",
  sand: "#e9cf8e",
  path: "#caa86a",
  pathEdge: "#9c7c44",

  skyTop: "#3a2f6e",
  skyDay: "#8ec5ff",
  skyDusk: "#f7b267",
  skyNight: "#1a1640",

  stone: "#9aa3b2",
  stoneDark: "#5f6877",
  wood: "#a9683b",
  woodDark: "#6e4022",
  roofRed: "#d65a4a",
  roofBlue: "#4a73d6",
  roofPurple: "#8b5cd6",

  gold: "#ffd86b",
  cyan: "#6be8ff",
  magenta: "#ff7ce5",
  green: "#8be36b",
  bubble: "#bff2ff",
  danger: "#ff6b7a",
  ink: "#1a1428",
} as const;

export const hexToNum = (hex: string): number => parseInt(hex.slice(1), 16);

// Visualizer kind → accent color used for that building's magic/glow.
export const KIND_ACCENT: Record<string, string> = {
  code: PAL.cyan,
  web: PAL.gold,
  art: PAL.magenta,
  book: "#c9a0ff",
  text: PAL.green,
  data: "#7ad6ff",
};
