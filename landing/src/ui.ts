/* Deep imports from the vendored @decentralpark/ui dist (module structure is
   preserved, bundle:false) so the landing page pulls only the presentational
   components — not the wallet/auth barrel and its web3 peer deps. */
export { default as Button } from "@decentralpark/ui/dist/components/buttons/button.mjs";
export {
  Heading1,
  Heading3,
  Body,
  Caption,
} from "@decentralpark/ui/dist/components/typography/Typography.mjs";
export { default as Logo } from "@decentralpark/ui/dist/components/Logo/Logo.mjs";
export { default as Chip } from "@decentralpark/ui/dist/components/chip/chip.mjs";
export { default as Footer } from "@decentralpark/ui/dist/components/footer/footer.mjs";
