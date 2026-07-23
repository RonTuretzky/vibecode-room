import "../chunk-FWCSY2DS.mjs";
const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
  }
};
export {
  copyToClipboard
};
