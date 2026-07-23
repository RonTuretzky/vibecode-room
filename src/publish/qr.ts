// Server-side QR code generation for the take-home Pages URL. One tiny
// wrapper over the `qrcode` dependency so every surface (wall card, deck HUD,
// the appended local deck slide) renders the SAME server-generated SVG — the
// browser bundle never needs a QR library, and the encoded URL is always the
// confirmed-200 https Pages URL.

import QRCode from "qrcode";

// A complete standalone <svg> element encoding `url`. Medium error correction
// + a real quiet zone: it must scan from a phone at projector distance, off a
// wall wash, through an iframe. The SVG scales losslessly, so display size is
// purely the consumer's CSS.
export async function qrCodeSvg(url: string): Promise<string> {
  return await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
  });
}
