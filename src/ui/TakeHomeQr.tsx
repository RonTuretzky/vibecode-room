import type { MouseEvent } from "react";

// The take-home QR block: renders the SERVER-generated SVG that encodes the
// published GitHub Pages URL ("scan to take it home"). Shown in two sizes:
//   - "card": on the wall fleet card, sized to scan from a phone at projector
//     distance;
//   - "deck": in the slideshow HUD next to the deck.
// The SVG arrives on the snapshot (process.publishedQrSvg) straight from the
// room server's own QR generator — trusted output, injected raw exactly like
// the fixture slide HTML. The whole block is a link to the same URL, and it
// stops click propagation so it never steers/selects the card underneath.
export interface TakeHomeQrProps {
  url: string;
  qrSvg: string;
  size: "card" | "deck";
}

export function TakeHomeQr({ url, qrSvg, size }: TakeHomeQrProps) {
  return (
    <a
      className={`take-home-qr-block ${size}`}
      data-testid="take-home-qr"
      data-published-url={url}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Published take-home deck: ${url}`}
      onClick={(clickEvent: MouseEvent) => clickEvent.stopPropagation()}
    >
      {/* Server-generated QR SVG (src/publish/qr.ts) — trusted, not user input. */}
      <span className="take-home-qr-svg" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <span className="take-home-qr-caption">scan to take it home</span>
    </a>
  );
}
