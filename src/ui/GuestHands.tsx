import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";
import type { HandsInfo } from "../server/remote-hands";

/**
 * Guest-hands overlay — how people in the room get hand controls on their own
 * computers. Shows the guest URL (big, typeable) plus a QR code, the live
 * connected-guest count, and honest degradation: no LAN address → an explicit
 * warning instead of a dead QR (same contract as the QR-import overlay).
 *
 * Info comes from GET /api/hands/info and REFRESHES while open (3s poll) so
 * the guest count is live — the whole point of opening this overlay is to
 * watch people join.
 */

export interface GuestHandsProps {
  onClose: () => void;
}

const POLL_MS = 3_000;

// Which URL the QR encodes / the big line shows: the https listener when bound
// (camera hand-tracking works there), else the plain-http page (trackpad).
export function preferredGuestUrl(info: Pick<HandsInfo, "url" | "httpsUrl">): string {
  return info.httpsUrl ?? info.url;
}

export function GuestHands({ onClose }: GuestHandsProps) {
  const [info, setInfo] = useState<HandsInfo | null>(null);
  const [infoError, setInfoError] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/hands/info", { headers: { accept: "application/json" } });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const payload = (await response.json()) as HandsInfo;
          if (!cancelled) {
            setInfo(payload);
            setInfoError(false);
          }
          return;
        }
      } catch {
        // fall through
      }
      if (!cancelled) {
        setInfoError(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (info === null || !info.lanReachable) {
      return;
    }
    let cancelled = false;
    toDataURL(preferredGuestUrl(info), { margin: 1, width: 280 })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [info?.url, info?.httpsUrl, info?.lanReachable]);

  return (
    <div className="detail-overlay qr-overlay" data-testid="guest-hands-overlay" onClick={onClose}>
      <div
        className="qr-card"
        role="dialog"
        aria-modal="true"
        aria-label="Guest hand controls"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="qr-head">
          <div>
            <span className="detail-eyebrow">guest hands</span>
            <h2 className="qr-title">Control this wall from your computer</h2>
          </div>
          <button type="button" className="detail-back" onClick={onClose} aria-label="Close guest hands">
            <span aria-hidden="true">←</span> back
          </button>
        </header>

        <div className="qr-success" data-testid="guest-hands-count" role="status">
          {info === null ? "…" : info.guestCount === 1 ? "1 guest connected" : `${info.guestCount} guests connected`}
        </div>

        {info !== null && info.lanReachable && qrDataUrl !== null ? (
          <img
            className="qr-image"
            data-testid="guest-hands-qr"
            src={qrDataUrl}
            alt={`QR code for ${preferredGuestUrl(info)}`}
          />
        ) : info !== null && !info.lanReachable ? (
          <div className="qr-image qr-image-pending" data-testid="guest-hands-unreachable">
            No LAN-reachable address
          </div>
        ) : (
          <div className="qr-image qr-image-pending" data-testid="guest-hands-pending">
            {infoError ? "Guest info unavailable — is the server running?" : "Generating code…"}
          </div>
        )}

        {info !== null ? (
          <code className="qr-url" data-testid="guest-hands-url">
            {preferredGuestUrl(info)}
          </code>
        ) : null}

        {info !== null && !info.lanReachable ? (
          <p className="qr-warning" data-testid="guest-hands-lan-warning">
            Other computers can't reach this address — no LAN address was found. Join a Wi-Fi
            network and reopen this overlay.
          </p>
        ) : null}

        <p className="qr-hint">
          Open the page on any computer or phone on this network: hover/point to aim, hold still
          on a control to click it, and hold the on-screen W/A/S/D buttons to walk the room
          camera. Camera hand-tracking (point with your hand, pinch to click) needs the https
          address{info !== null && info.httpsUrl === null ? " — start the room with run-room.sh to enable it" : " (accept the one-time certificate warning)"}.
        </p>
      </div>
    </div>
  );
}

// ALWAYS-ON GUEST BADGE (live-room request: "there should always be a qr code
// for guests, a small one at the bottom left"). The full overlay above is
// opt-in behind the 🖐 button; this is the standing invitation — a small QR in
// the bottom-left corner of every wall, so joining never requires finding a
// button first. Fetches the guest URL once (it is fixed per boot; one retry),
// and stays honest: no LAN-reachable URL → no badge, never a dead QR.
export function GuestQrBadge() {
  const [guestQr, setGuestQr] = useState<{ img: string; url: string } | null>(null);

  // Both standing invitations load once per boot (their URLs are fixed), one
  // retry each; either failing simply leaves its half off — never a dead QR.
  useEffect(() => {
    let cancelled = false;
    const loadGuest = async (attempt: number): Promise<void> => {
      try {
        const response = await fetch("/api/hands/info", { headers: { accept: "application/json" } });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const info = (await response.json()) as HandsInfo;
        if (cancelled || info.lanReachable === false) {
          return;
        }
        const guestUrl = preferredGuestUrl(info);
        const encoded = await toDataURL(guestUrl, { margin: 1, width: 104 });
        if (!cancelled) {
          setGuestQr({ img: encoded, url: guestUrl });
        }
      } catch {
        if (!cancelled && attempt < 1) {
          setTimeout(() => void loadGuest(attempt + 1), 5_000);
        }
      }
    };
    void loadGuest(0);
    return () => {
      cancelled = true;
    };
  }, []);

  if (guestQr === null) {
    return null;
  }
  return (
    <div className="guest-qr-badge" data-testid="guest-qr-badge">
      {guestQr !== null ? (
        <figure title={`Scan on your phone: point at the wall with your hands AND plant a project (the add-a-project fold on the same page) — ${guestQr.url}`}>
          <img src={guestQr.img} alt="QR code — join as a guest and point at the wall from your phone" />
          <figcaption>🖐 join · ➕ import</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
