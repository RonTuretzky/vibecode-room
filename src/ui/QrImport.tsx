import { useEffect, useMemo, useRef, useState } from "react";
import { toDataURL } from "qrcode";
import type { ProjectorProcess } from "./types";

/**
 * QR import overlay — scan on a phone, describe what the fleet should build
 * (plus an optional link; GitHub repos get cloned), watch it join the fleet as
 * a REAL in-progress project.
 *
 * The overlay asks the server for its LAN-reachable /submit URL
 * (GET /api/import/info — normally the dedicated 0.0.0.0 phone listener) and
 * renders the QR entirely client-side with the `qrcode` package (toDataURL
 * onto an <img> — no extra network dependency). When no LAN address exists
 * (or the legacy loopback-bind fallback is in play) the QR is NOT rendered —
 * a dead QR that scans but never loads is worse than an explicit warning.
 *
 * Success feedback: the overlay watches the live snapshot's processes — a NEW
 * phone-sourced process ("github-import" or "phone-import") appearing means a
 * submission landed, and a success flash confirms it to the room.
 */

export interface ImportInfo {
  submitUrl: string;
  host: string;
  lanReachable: boolean;
}

export interface QrImportProps {
  processes: ProjectorProcess[];
  onClose: () => void;
}

// The overlay's QR-panel decision, pure so it is unit-testable without a DOM:
// a scannable-looking QR pointing at an unreachable address is a trap, so the
// unreachable state REPLACES the image, it never renders alongside it.
export function qrPanelState(
  info: ImportInfo | null,
  qrDataUrl: string | null,
): "image" | "unreachable" | "pending" {
  if (info !== null && !info.lanReachable) {
    return "unreachable";
  }
  if (info !== null && qrDataUrl !== null) {
    return "image";
  }
  return "pending";
}

export function QrImport({ processes, onClose }: QrImportProps) {
  const [info, setInfo] = useState<ImportInfo | null>(null);
  const [infoError, setInfoError] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  // Fetch the submit URL once per open. Non-authoritative projector: a failed
  // fetch must never block the UI — it degrades to an inline error hint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/import/info", { headers: { accept: "application/json" } });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const payload = (await response.json()) as ImportInfo;
          if (!cancelled) {
            setInfo(payload);
          }
          return;
        }
      } catch {
        // Fall through to the error hint below.
      }
      if (!cancelled) {
        setInfoError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Render the QR client-side once the submit URL is known.
  useEffect(() => {
    if (info === null) {
      return;
    }
    let cancelled = false;
    toDataURL(info.submitUrl, { margin: 1, width: 280 })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInfoError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [info]);

  // Success flash: baseline the phone-sourced count at open; any INCREASE while
  // the overlay is up means a submission just landed on the wall.
  const importCount = useMemo(
    () =>
      processes.filter(
        (process) => process.source?.kind === "github-import" || process.source?.kind === "phone-import",
      ).length,
    [processes],
  );
  const baselineRef = useRef(importCount);
  useEffect(() => {
    if (importCount > baselineRef.current) {
      baselineRef.current = importCount;
      setImported(true);
      const timer = setTimeout(() => setImported(false), 4_000);
      return () => clearTimeout(timer);
    }
    baselineRef.current = importCount;
  }, [importCount]);

  return (
    <div className="detail-overlay qr-overlay" data-testid="qr-overlay" onClick={onClose}>
      <div
        className="qr-card"
        role="dialog"
        aria-modal="true"
        aria-label="Import a project by QR code"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="qr-head">
          <div>
            <span className="detail-eyebrow">project import</span>
            <h2 className="qr-title">Scan to add a project</h2>
          </div>
          <button type="button" className="detail-back" onClick={onClose} aria-label="Close QR import">
            <span aria-hidden="true">←</span> back
          </button>
        </header>

        {imported ? (
          <div className="qr-success" data-testid="qr-import-success" role="status">
            ✓ Added to the wall
          </div>
        ) : null}

        {qrPanelState(info, qrDataUrl) === "image" ? (
          <img
            className="qr-image"
            data-testid="qr-code-image"
            src={qrDataUrl ?? undefined}
            alt={`QR code for ${info?.submitUrl ?? ""}`}
          />
        ) : qrPanelState(info, qrDataUrl) === "unreachable" ? (
          <div className="qr-image qr-image-pending" data-testid="qr-code-unreachable">
            No phone-reachable address
          </div>
        ) : (
          <div className="qr-image qr-image-pending" data-testid="qr-code-pending">
            {infoError ? "Import info unavailable — is the server running?" : "Generating code…"}
          </div>
        )}

        {info !== null ? (
          <code className="qr-url" data-testid="qr-submit-url">
            {info.submitUrl}
          </code>
        ) : null}

        {info !== null && !info.lanReachable ? (
          <p className="qr-warning" data-testid="qr-lan-warning">
            Phones can't reach this address — no LAN address was found. Join a Wi-Fi network (or
            check the phone listener / HOST binding) and reopen this overlay.
          </p>
        ) : null}

        <p className="qr-hint">
          Open the page on your phone, describe what the fleet should build, and optionally add a
          link — a GitHub repo gets cloned; any link becomes reference context. It joins the fleet
          as a real project in progress.
        </p>
      </div>
    </div>
  );
}
