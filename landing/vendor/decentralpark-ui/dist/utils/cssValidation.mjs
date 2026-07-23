import "../chunk-FWCSY2DS.mjs";
const REQUIRED_CSS_VARS = [
  "--color-primary-green",
  "--color-paper-main",
  "--color-surface-ink",
  "--color-system-red",
  "--color-system-green",
  "--color-green-1",
  "--color-paper-2"
];
let hasWarned = false;
function validateCSSVariables() {
  if (hasWarned || typeof window === "undefined") return;
  const missingVars = [];
  REQUIRED_CSS_VARS.forEach((varName) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(
      varName
    );
    if (!value || value.trim() === "") {
      missingVars.push(varName);
    }
  });
  if (missingVars.length > 0 && !hasWarned) {
    hasWarned = true;
    console.warn(
      `\u{1F6A8} @decentralpark/ui: Missing CSS variables detected!

Missing variables: ${missingVars.join(", ")}

To fix this, import the theme CSS in your main CSS file:

@import '@decentralpark/ui/theme';

Or use the Tailwind preset:
module.exports = { presets: [require('@decentralpark/ui/tailwind-preset')] }`
    );
  }
}
if (process.env.NODE_ENV === "development") {
  setTimeout(validateCSSVariables, 100);
}
export {
  validateCSSVariables
};
