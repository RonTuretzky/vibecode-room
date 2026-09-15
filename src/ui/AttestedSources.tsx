import type { AttestedSourceSummary } from "../attest/registry";

// CREDIBLE SENSORS badge: one chip per attested phone. "What the sensor claims,
// what you can check" — verified hardware attestation reads green; a leaf-only
// source (no Warden verifier configured) is amber and says so; a broken stream
// or session reads red. Counts are signed chunks that MATCHED the bytes the
// room consumed, per stream.
export function AttestedSources({ sources }: { sources: ReadonlyArray<AttestedSourceSummary> }) {
  if (sources.length === 0) return null;
  return (
    <div className="attested-sources" data-testid="attested-sources" aria-label="Attested sensors">
      {sources.map((s) => {
        const broken = s.session === "broken" || Object.values(s.streams).some((st) => st?.broken);
        const tone = broken ? "broken" : s.verified === "hardware" ? "hardware" : "leaf-only";
        const streams = (["audio", "hands", "gesture", "video"] as const)
          .filter((k) => s.streams[k] !== undefined)
          .map((k) => `${k} ${s.streams[k]!.accepted}${s.streams[k]!.rejected > 0 ? `/${s.streams[k]!.rejected}✗` : ""}`)
          .join(" · ");
        const title = [
          s.verified === "hardware" ? "Hardware attestation verified by Warden" : "UNVERIFIED: no Warden verifier configured — facts are the phone's own claims",
          `key: ${s.keySecurityLevel ?? "?"}`,
          `bootloader: ${s.bootloaderLocked === null ? "?" : s.bootloaderLocked ? "locked" : "UNLOCKED"} · boot: ${s.verifiedBootState ?? "?"}`,
          `app: ${s.packageName ?? "?"}`,
          s.fresh ? `challenge issued ${s.freshness?.issuedAt ?? ""}` : "challenge not issued by this room (freshness unproven)",
          `session: ${s.session}${s.sessionError ? ` — ${s.sessionError}` : ""}`,
        ].join("\n");
        return (
          <span key={s.id} className={`attested-source ${tone}`} data-testid="attested-source" data-verified={s.verified} title={title}>
            <span className="attested-lock" aria-hidden="true">{tone === "broken" ? "⚠" : "🔒"}</span>
            <span className="attested-label">{s.label}</span>
            <span className="attested-facts">
              {s.keySecurityLevel ?? "?"} · {s.bootloaderLocked ? "locked" : "unlocked"}
              {s.verified === "leaf-only" ? " · unverified" : ""}
              {s.fresh ? " · fresh" : ""}
            </span>
            {streams.length > 0 ? <span className="attested-streams">{streams}</span> : null}
            {s.session === "sealed" ? <span className="attested-sealed">sealed</span> : null}
          </span>
        );
      })}
    </div>
  );
}
