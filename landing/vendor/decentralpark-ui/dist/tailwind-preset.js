/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      colors: {
        // Decentral Park brand colors
        "core-green": "#16a34a",
        "primary-green": "#16a34a",
        "green-0": "#86efac",
        "green-1": "#15803d",
        "green-2": "#166534",
        "primary-pine": "#0d9488",
        "pine-0": "#5eead4",
        "pine-1": "#0f766e",
        "pine-2": "#134e4a",
        "primary-sky": "#0284c7",
        "sky-0": "#7dd3fc",
        "sky-1": "#0369a1",
        "sky-2": "#075985",
        "paper-main": "#f0fdf4",
        "paper-0": "#ffffff",
        "paper-1": "#dcfce7",
        "paper-2": "#bbf7d0",
        "surface-ink": "#14211a",
        "surface-grey": "#808080",
        "surface-grey-2": "#595959",
        "surface-brown": "#513c35",
        "surface-brown-1": "#301f18",
        "system-green": "#16a34a",
        "system-red": "#df0b00",
        "system-warning": "#ce7f00",
        "text-standard": "#0a0a0a",
        white: "#ffffff",
        black: "#000000",
      },
      fontFamily: {
        parkDisplay: [
          "var(--font-parkDisplay)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        parkBody: [
          "var(--font-parkBody)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        roboto: ["var(--font-roboto)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
