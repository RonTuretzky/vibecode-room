import "../chunk-FWCSY2DS.mjs";
function formatBalance(value, decimals = 2) {
  const balanceFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    minimumIntegerDigits: 1,
    useGrouping: true
  });
  return balanceFormatter.format(value);
}
export {
  formatBalance
};
