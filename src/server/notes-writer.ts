// Explicit notes-only demo writer (VIBERSYN_BRANCH_WRITER=notes).
// Production branch requests use BranchJobs; this is never an outage fallback.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The gate: default ON; VIBERSYN_STEER_APPLIER=0 disables the whole pipeline.
export function steerApplierEnabled(env: Record<string, string | undefined>): boolean {
  return env.VIBERSYN_STEER_APPLIER !== "0";
}

// The applier only needs the edit+commit rail — injectable so unit tests
// assert the exact call args without a TreeGitSubstrate (or any git
// subprocess). The contract: the substrate runs `edit` inside the SAME
// per-upid chain slot as the commit (no other branch op interleaves), and an
// edit failure returns {ok:false, error} with NO commit — never a throw.
export interface SteerApplierGit {
  commitBranchWithEdit(
    upid: string,
    branch: string,
    message: string,
    edit: () => Promise<void>,
  ): Promise<{ ok: true; branch: string; changed: boolean } | { ok: false; error: string }>;
}

export interface ApplySteerEditInput {
  // The adopted clone's working tree (builds/<upid>/repo) — THE injectable fs
  // root: every path this module touches resolves under it.
  repoDir: string;
  // The room/<slug> branch the commit lands on (commitBranch normalizes).
  branch: string;
  // The joined spoken slice (transcript-slice.ts).
  text: string;
  upid: string;
  treeGit: SteerApplierGit;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export type ApplySteerEditResult =
  // unchanged:true = the edit produced a tree identical to the branch tip
  // (commitBranch's no-change guard) — no noise commit was made.
  | { ok: true; branch: string; unchanged: boolean }
  | { ok: false; error: string };

const COMMIT_MESSAGE_MAX_CHARS = 60;
// Case-insensitive CONTAINS match: the spoken text names the dashboard when
// it mentions any of these.
const DASHBOARD_TARGETS = ["welcome", "note", "board"] as const;
const DASHBOARD_RELATIVE_PATH = join("dashboard", "index.html");

export async function applySteerEdit(input: ApplySteerEditInput): Promise<ApplySteerEditResult> {
  const env = input.env ?? process.env;
  if (!steerApplierEnabled(env)) {
    return { ok: false, error: "steer applier disabled (VIBERSYN_STEER_APPLIER=0)" };
  }
  const text = input.text.replace(/\s+/gu, " ").trim();
  if (text.length === 0) {
    return { ok: false, error: "empty steer text — nothing to apply" };
  }
  const now = input.now ?? Date.now;
  // The fs edits ride INSIDE the substrate's per-upid chain slot with the
  // commit — see SteerApplierGit. The seam contract is "honest results, never
  // a throw"; the catch here is belt and braces for a misbehaving injection.
  let committed: Awaited<ReturnType<SteerApplierGit["commitBranchWithEdit"]>>;
  try {
    committed = await input.treeGit.commitBranchWithEdit(
      input.upid,
      input.branch,
      `room: ${clampLine(text, COMMIT_MESSAGE_MAX_CHARS)}`,
      async () => {
        await appendRoomNote(input.repoDir, text, now);
        if (mentionsDashboard(text)) {
          await insertDashboardNote(input.repoDir, input.branch, text);
        }
      },
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!committed.ok) {
    return committed;
  }
  return { ok: true, branch: committed.branch, unchanged: !committed.changed };
}

// Append "## <ISO date> — spoken in the room\n\n<text>\n" to ROOM-NOTES.md at
// the repo root, separated from any existing content by one blank line.
async function appendRoomNote(repoDir: string, text: string, now: () => number): Promise<void> {
  const notesPath = join(repoDir, "ROOM-NOTES.md");
  const entry = `## ${new Date(now()).toISOString()} — spoken in the room\n\n${text}\n`;
  await appendFile(notesPath, existsSync(notesPath) ? `\n${entry}` : entry, "utf8");
}

function mentionsDashboard(text: string): boolean {
  const lowered = text.toLowerCase();
  return DASHBOARD_TARGETS.some((target) => lowered.includes(target));
}

// One marked block into dashboard/index.html: a <!-- room:<branch>: … -->
// comment plus the visible note, inserted after the opening <body> tag (or
// after the doctype — never before it — when no <body> exists). The
// branch-scoped marker makes the insertion idempotent — a second slice on the
// same branch never stacks a second note. The idempotence probe includes the
// trailing colon delimiter, so a branch whose name is a PREFIX of an
// already-noted branch (room/issue-1 after room/issue-12 — reachable via the
// IssuePopup take flow's room/issue-<n> names) still gets its own insertion.
async function insertDashboardNote(repoDir: string, branch: string, text: string): Promise<void> {
  const dashboardPath = join(repoDir, DASHBOARD_RELATIVE_PATH);
  if (!existsSync(dashboardPath)) {
    return;
  }
  const html = await readFile(dashboardPath, "utf8");
  const marker = `<!-- room:${branch}:`;
  if (html.includes(marker)) {
    return; // already inserted for this branch — bounded to one insertion
  }
  // The comment must not terminate early (`-->` and the spec's other closer
  // `--!>` both end a comment); the visible note must not inject markup.
  const commentSafe = text.replace(/-{2,}!?>/gu, " ").replace(/\s+/gu, " ").trim();
  const block = `${marker} ${commentSafe} -->\n<p class="room-note">${escapeHtml(text)}</p>\n`;
  const body = /<body[^>]*>/iu.exec(html);
  let updated: string;
  if (body === null) {
    // No <body> at all: keep any doctype FIRST (prepending would flip the
    // document into quirks mode), then the block.
    const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
    updated =
      doctype === null ? `${block}${html}` : `${html.slice(0, doctype[0].length)}\n${block}${html.slice(doctype[0].length)}`;
  } else {
    const insertAt = body.index + body[0].length;
    updated = `${html.slice(0, insertAt)}\n${block}${html.slice(insertAt)}`;
  }
  await writeFile(dashboardPath, updated, "utf8");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

// One-line clamp (whitespace already collapsed by the caller).
function clampLine(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
