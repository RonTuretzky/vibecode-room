import type { ResearchQuest } from "../research";
import type { ResearchTrayItem } from "../ui/types";

// Map the research ledger to the wall's tray items (the loop already orders
// quests: researching → proposed by confidence → complete → failed). Pure so
// the snapshot shape is testable without a runtime.
export function researchTrayFromQuests(quests: readonly ResearchQuest[]): ResearchTrayItem[] {
  return quests.map(researchTrayItemFromQuest);
}

export function researchTrayItemFromQuest(quest: ResearchQuest): ResearchTrayItem {
  const report = quest.report;
  const verdicts =
    report === null
      ? undefined
      : report.findings.reduce(
          (counts, finding) => {
            counts[finding.verdict] += 1;
            return counts;
          },
          { supported: 0, refuted: 0, mixed: 0, unverified: 0 },
        );
  return {
    id: quest.id,
    kind: quest.kind,
    topic: quest.topic,
    claim: quest.claim,
    confidence: quest.confidence,
    status: quest.status,
    progress: quest.progress,
    progressLabel: quest.progressLabel,
    rationale: quest.rationale.length > 0 ? quest.rationale : undefined,
    evidence: quest.contextSpan.quote.length > 0 ? quest.contextSpan.quote : undefined,
    turnId: quest.contextSpan.endTurnId,
    sourceCount: report?.sources.length ?? 0,
    biasCount: report?.biasNotes.length ?? 0,
    verdicts,
    // Live findings (draft while verification runs, final once complete),
    // capped so the tray card stays glanceable.
    findings:
      report === null ? undefined : report.findings.slice(0, 4).map((finding) => ({ claim: finding.claim, verdict: finding.verdict })),
    draft: quest.reportDraft === true ? true : undefined,
    followUps:
      report !== null && quest.status === "complete" && report.followUps.length > 0 ? report.followUps.slice(0, 4) : undefined,
    degraded: report?.degraded !== undefined && report.degraded.length > 0 ? report.degraded : undefined,
    deckUrl: quest.status === "complete" ? `/api/research/${encodeURIComponent(quest.id)}/deck` : null,
    error: quest.error ?? undefined,
  };
}
