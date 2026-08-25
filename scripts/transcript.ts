#!/usr/bin/env bun
//
// READ THE ROOM'S TRANSCRIPT ARCHIVE.
//
// The operator asked for "today's transcript" and the answer was a hand-written
// python pass over a rolling 400-line JSON file that had already evicted most
// of the evening. This reads the day-segmented archive directly — NO SERVER —
// which matters because the moment you want last night's conversation is
// usually the moment the room is down.
//
//   bun scripts/transcript.ts                 today
//   bun scripts/transcript.ts yesterday
//   bun scripts/transcript.ts 2026-08-24
//   bun scripts/transcript.ts --days          list the days the archive holds
//   bun scripts/transcript.ts today --json    raw JSONL lines as a JSON array
//   bun scripts/transcript.ts today --grep birdhouse
//   bun scripts/transcript.ts --dir <path>    read a different archive
//   bun scripts/transcript.ts --import <file> fold a legacy/rescue snapshot in
//
import { resolve } from "node:path";
import {
  TRANSCRIPT_ARCHIVE_DEFAULT_DIR,
  listDays,
  localDayKey,
  parseLegacyBody,
  readDay,
  renderTranscriptText,
  resolveDayKey,
  resolveTranscriptArchiveDir,
} from "../src/server/transcript-archive";
import { TranscriptStore } from "../src/server/transcript-store";

interface Args {
  day: string;
  dir: string;
  json: boolean;
  days: boolean;
  grep: string | null;
  importPath: string | null;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = {
    day: "today",
    // The same default the boot entry uses, so the CLI and the room agree
    // without either being told where the archive is.
    dir: resolveTranscriptArchiveDir(process.env) ?? resolve(process.cwd(), TRANSCRIPT_ARCHIVE_DEFAULT_DIR),
    json: false,
    days: false,
    grep: null,
    importPath: null,
  };
  let sawDay = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--days") {
      args.days = true;
    } else if (arg === "--dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--dir needs a directory" };
      }
      args.dir = value;
      index += 1;
    } else if (arg === "--grep") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--grep needs a pattern" };
      }
      args.grep = value;
      index += 1;
    } else if (arg === "--import") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--import needs a file" };
      }
      args.importPath = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { error: "help" };
    } else if (arg.startsWith("-")) {
      return { error: `unknown flag ${arg}` };
    } else if (!sawDay) {
      args.day = arg;
      sawDay = true;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  return args;
}

const USAGE = `read the room's transcript archive

  bun scripts/transcript.ts [today|yesterday|YYYY-MM-DD] [--json] [--grep <pattern>]
  bun scripts/transcript.ts --days
  bun scripts/transcript.ts --import <legacy-or-rescue.json>
  bun scripts/transcript.ts --dir <archive-directory>`;

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  if (parsed.error !== "help") {
    console.error(`transcript: ${parsed.error}\n`);
  }
  console.error(USAGE);
  process.exit(parsed.error === "help" ? 0 : 2);
}

const args = parsed;

// --import folds a snapshot (the pre-archive builds/session-transcript.json, or
// a rescue copy of it) through the SAME de-duping merge the boot migration
// uses, so importing the same file twice — or two overlapping snapshots — is
// safe and recovers the union. Explicit rather than glob-magic on purpose.
if (args.importPath !== null) {
  const path = resolve(args.importPath);
  let body: string;
  try {
    body = await Bun.file(path).text();
  } catch (error) {
    console.error(`transcript: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  }
  let lines;
  try {
    lines = parseLegacyBody(body);
  } catch (error) {
    console.error(`transcript: ${path} is not a transcript snapshot (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  }
  if (lines.length === 0) {
    console.error(`transcript: ${path} holds no readable transcript lines — nothing imported.`);
    process.exit(1);
  }
  // legacyPath: null — an --import must fold exactly the file it was given and
  // must not also sweep up whatever legacy file happens to sit near the archive.
  const store = new TranscriptStore({
    dir: args.dir,
    legacyPath: null,
    onNote: (note) => (note.level === "warn" ? console.error(note.message) : console.log(note.message)),
  });
  const before = new Map(listDays(args.dir).map((day) => [day, readDay(args.dir, day).lines.length]));
  const touched = store.importLines(lines);
  if (touched === null) {
    console.error(`transcript: import FAILED — ${path} was left untouched.`);
    process.exit(1);
  }
  for (const day of touched) {
    const after = readDay(args.dir, day).lines.length;
    const had = before.get(day) ?? 0;
    console.log(`${day}: ${had} -> ${after} lines (+${after - had} new, ${lines.length} offered)`);
  }
  console.log(`imported ${lines.length} line(s) from ${path} into ${args.dir}`);
  process.exit(0);
}

if (args.days) {
  const days = listDays(args.dir);
  if (days.length === 0) {
    console.error(`transcript: no archive at ${args.dir} yet — the room writes one as soon as somebody speaks.`);
    process.exit(1);
  }
  for (const day of days) {
    const segment = readDay(args.dir, day);
    const suffix = segment.skipped > 0 ? ` (${segment.skipped} unreadable)` : "";
    console.log(`${day}  ${String(segment.lines.length).padStart(6)} lines${suffix}`);
  }
  process.exit(0);
}

const day = resolveDayKey(args.day, Date.now());
if (day === null) {
  console.error(`transcript: "${args.day}" is not a day — use YYYY-MM-DD, today, or yesterday.`);
  process.exit(2);
}

const segment = readDay(args.dir, day);
if (!segment.exists) {
  // Never a bare empty output: an empty transcript and a missing one are
  // different facts, and the operator must be able to tell them apart.
  const days = listDays(args.dir);
  console.error(
    `transcript: no transcript for ${day} in ${args.dir}.` +
      (days.length > 0 ? ` Days on hand: ${days.join(", ")}` : " The archive is empty."),
  );
  process.exit(1);
}
if (segment.skipped > 0) {
  console.error(`transcript: ${segment.skipped} unreadable line(s) in ${segment.path} (a truncated write) — the rest is below.`);
}

const pattern = args.grep === null ? null : new RegExp(args.grep, "i");
const lines = pattern === null ? segment.lines : segment.lines.filter((line) => pattern.test(line.text));

if (args.json) {
  console.log(JSON.stringify(lines, null, 2));
} else {
  if (lines.length > 0) {
    console.log(renderTranscriptText(lines));
  }
  const scope = pattern === null ? "" : ` matching /${args.grep}/i`;
  const todayNote = day === localDayKey(Date.now()) ? " (today, still being written)" : "";
  console.error(`\n— ${lines.length} line(s)${scope} from ${day}${todayNote} · ${segment.path}`);
}
