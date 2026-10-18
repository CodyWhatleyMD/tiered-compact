import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord, originKey, type Turn } from "./transcript";

export const SUMMARIES_FILENAME = "tiered-summaries.json";

/**
 * Summaries file contract (mode B — "the summarizer is the live session"):
 *
 *   {
 *     "summaries": { "<turnKey>": "<summary text>", ... }
 *   }
 *
 * turnKey = the ORIGIN uuid of the FIRST row of the turn — the id that row had
 * when first written, carried through every compaction since (transcript.ts
 * originKey). This comment used to claim "uuids never change"; that held across
 * replans but NOT across compactions, where compact.ts re-mints every uuid on
 * copy. The consequence was silent and total: a summary became unlinkable at
 * the exact moment its turn got compacted — i.e. the moment it began to matter.
 * Found 2026-07-30 after a compaction dropped a founding conversation and the
 * 63 summaries covering it could not be re-attached to anything.
 *
 * The live in-context instance enumerates turns with `bun src/plan.ts
 * <transcript> <keepN>`, writes this file next to the transcript, and then
 * the user runs /tiered-compact N — the hook consumes the file instead of
 * spawning a headless `claude -p --resume`, which cannot survive large
 * transcripts ("Prompt is too long" at ~45MB, observed 2026-07-08).
 *
 * Missing keys are a hard error, not a fallback: a prepared file signals
 * intent, and silently re-summarizing with the resume path would discard the
 * curation. Turns that appear after planning belong to the compaction run itself and
 * must carry the SCAFFOLD_MARKER so they need no summaries.
 */
export type SummariesFile = {
  summaries: Record<string, string>;
  /** Session id of the transcript these summaries were authored against. */
  transcript?: string;
};

/**
 * The session id a transcript path names (basename minus .jsonl).
 *
 * Summaries are prepared per-session but live in a per-PROJECT directory, so
 * two sessions in the same project share one filename. On 2026-08-18 a
 * /tiered-compact typed into the wrong tab consumed (and retired) another
 * thread's prepared summaries: zero keys matched, nothing was assembled, and
 * the rightful session was left with an empty shelf and no error anywhere.
 * Stamping the file with its transcript makes that mismatch loud.
 */
export function transcriptId(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, "");
}

export function turnKey(turn: Turn): string {
  const first = turn.rows[0];
  if (!first) {
    throw new Error("Turn has no rows; cannot derive a turn key.");
  }
  // originKey, not uuid: a turn that has survived a compaction carries its
  // ORIGINAL id, so a summary written before that compaction still resolves.
  // For never-compacted rows originKey === uuid, so this is a no-op there.
  return originKey(first);
}

/**
 * A turn's summary, matched by ANY of its row uuids (first row preferred).
 *
 * The canonical key is the first-row uuid (what plan.ts prints), but a live
 * instance authoring the file by hand tends to key by the uuid it can most
 * easily see — the assistant row. That off-by-one-row keying made every
 * summary "missing" on 2026-07-22 (63 mismatches out of 63). Any row of the
 * turn identifies it unambiguously, so accept them all.
 */
export function resolveTurnSummary(
  file: SummariesFile,
  turn: Turn,
): string | null {
  // First-match-wins was silently lossy on FOLDED turns. buildAssistantTurns
  // folds consecutive human messages into ONE turn (a new turn only starts
  // once an assistant has spoken), and 1,125 of 9,300 turns across the 25
  // largest real transcripts here — 12.1% — have more than one human row;
  // some have four. An author who read those as separate exchanges writes a
  // summary for each, and every one after the first was dropped without a
  // word, because the orphan check below only ran when something was MISSING
  // and nothing was.
  //
  // Two keys carrying the SAME text is harmless (the same turn keyed by both
  // its user row and its assistant row — the 2026-07-22 case this function
  // exists to tolerate). Two keys carrying DIFFERENT text means the author
  // believed there were two turns here, and silently discarding one of them
  // is the failure. Say so instead.
  let found: { key: string; summary: string } | null = null;
  for (const row of turn.rows) {
    for (const key of [row.uuid, originKey(row)]) {
      const summary = file.summaries[key];
      if (summary === undefined) {
        continue;
      }
      if (found === null) {
        found = { key, summary };
        continue;
      }
      if (key !== found.key && summary !== found.summary) {
        throw new Error(
          `${SUMMARIES_FILENAME} has conflicting summaries for one turn: keys `
            + `${found.key} and ${key} both fall inside the same turn but carry `
            + "different text. Consecutive human messages with no assistant "
            + "reply between them are ONE turn — write a single summary "
            + `covering all of them, keyed to ${turnKey(turn)}.`,
        );
      }
    }
  }
  return found === null ? null : found.summary;
}

export function summariesPath(transcriptPath: string): string {
  return join(dirname(transcriptPath), SUMMARIES_FILENAME);
}


/**
 * A stamp is honored when it names THIS session — or a provable ANCESTOR of
 * it. Session ids drift between authoring and assembly (native splits,
 * tiered-compact mints, client restarts): on 2026-08-27 a valid, fully-authored
 * eras file was refused because its author session had been compacted in between,
 * and the unblock was a human restamping the file by hand. Lineage is
 * provable from the transcript itself: a continuation carries its ancestor's
 * session id in its rows (copied sessionId fields, origin references). The
 * guard's purpose is stopping WRONG-TAB consumption — a different lineage —
 * not rejecting a session that has been compacted before.
 */
/**
 * A stamp is honored when it names THIS session — or a provable ANCESTOR:
 * a session id that appears as a PARSED FIELD VALUE in this transcript's
 * rows. Membership over parsed fields, never substring over prose — the
 * first version grepped raw text, and its own refusal message (which names
 * the offending stamp) landed in the transcript and poisoned the guard on
 * the second attempt: a single-use guard defeated by its own error text
 * (independent review, finding 1, verified by execution). Prose
 * cannot poison a set of parsed field values: an error message QUOTING a
 * stamp is just text and never enters the set.
 *
 * The stamp must also be UUID-shaped: a stamp that isn't a session id is
 * malformed regardless of whether it's dangerous (finding 2: the unanchored
 * substring version accepted {"transcript": "e"} against every transcript
 * in existence).
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function stampMatchesLineage(
  stamp: string,
  transcriptPath: string,
): Promise<boolean> {
  // Exact match first: the id is whatever the harness minted, shape-checked
  // or not. The UUID gate protects only the ANCESTOR path, where a malformed
  // stamp could otherwise go fishing for accidental membership.
  if (stamp === transcriptId(transcriptPath)) {
    return true;
  }
  if (!UUID_SHAPE.test(stamp)) {
    return false;
  }
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) {
    return false;
  }
  const ancestors = new Set<string>();
  for (const line of (await file.text()).split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    for (const key of ["sessionId", "originSessionId", "logicalParentSessionId"]) {
      const value = row[key];
      if (typeof value === "string") {
        ancestors.add(value);
      }
    }
  }
  return ancestors.has(stamp);
}

export async function loadSummariesFile(
  transcriptPath: string,
): Promise<SummariesFile | null> {
  const file = Bun.file(summariesPath(transcriptPath));
  if (!(await file.exists())) {
    return null;
  }

  const parsed: unknown = JSON.parse(await file.text());
  if (!isRecord(parsed) || !isRecord(parsed["summaries"])) {
    throw new Error(
      `${SUMMARIES_FILENAME} is malformed: expected {"summaries": {"<uuid>": "<text>"}}.`,
    );
  }

  const entries = Object.entries(parsed["summaries"]);
  if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
    throw new Error(
      `${SUMMARIES_FILENAME}: keys are numeric indices, but the contract is `
        + "row uuids — run `bun src/plan.ts <transcript> <keepN>` and use each "
        + "turn's `key` field verbatim (indices drift as the transcript grows; "
        + "uuids don't).",
    );
  }

  const stamp = parsed["transcript"];
  if (stamp !== undefined) {
    if (typeof stamp !== "string" || stamp.trim() === "") {
      throw new Error(
        `${SUMMARIES_FILENAME}: "transcript" must be the session id these `
          + "summaries were prepared for.",
      );
    }
    const here = transcriptId(transcriptPath);
    if (!(await stampMatchesLineage(stamp, transcriptPath))) {
      throw new Error(
        `${SUMMARIES_FILENAME} was prepared for session ${stamp}, which is `
          + `neither this session (${here}) nor an ancestor found in its `
          + "transcript. Nothing was consumed. Run the command from the "
          + "session that authored it (its summaries are untouched), or "
          + "move that file aside and prepare summaries for this one.",
      );
    }
  }

  const summaries: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `${SUMMARIES_FILENAME}: summary for ${key} must be a non-empty string.`,
      );
    }
    summaries[key] = value.trim();
  }
  return { summaries };
}

export function resolveSummariesFromFile(
  file: SummariesFile,
  turns: Turn[],
): string[] {
  const missing = turns.filter(turn => resolveTurnSummary(file, turn) === null);
  if (missing.length > 0) {
    const turnUuids = new Set(
      turns.flatMap(turn => turn.rows.flatMap(r => [r.uuid, originKey(r)])),
    );
    const orphanKeys = Object.keys(file.summaries).filter(
      key => !turnUuids.has(key),
    ).length;
    throw new Error(
      `${SUMMARIES_FILENAME} is missing ${missing.length} turn(s): `
        + `${missing.slice(0, 5).map(turnKey).join(", ")}${missing.length > 5 ? ", …" : ""}. `
        + `(${orphanKeys} file key(s) match no needed turn — if that number is `
        + "large, the keys are probably from the wrong rows or a stale plan: "
        + "use the `key` field from `bun src/plan.ts <transcript> <keepN>` "
        + "verbatim; any row uuid of the turn is accepted.) "
        + "New turns from the compaction run itself should carry the scaffold marker "
        + "instead of summaries.",
    );
  }
  return turns.map(turn => resolveTurnSummary(file, turn)!);
}

/** Park the consumed file so a later compaction can't silently reuse it. */
export async function retireSummariesFile(
  transcriptPath: string,
): Promise<void> {
  const path = summariesPath(transcriptPath);
  await rename(path, `${path}.used`).catch(() => undefined);
}
