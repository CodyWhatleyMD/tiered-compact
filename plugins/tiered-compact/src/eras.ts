/**
 * Era-collapse (`--eras`): the lever for mature lineages.
 *
 * Every compaction preserves N turns whole; at the next compaction they have
 * moved into the prefix, where nothing touches them, and they ride at full
 * fidelity forever. Measured 2026-08-25 on a mature lineage: prefix=533,
 * summarized=0, preserved=7 — compaction had become a no-op, sessions born at
 * ~370-750k tokens, ~55% of it prose no tier ever reached. Deep history was
 * never being compressed at all.
 *
 * An era is one prior generation's contribution to the prefix: its run of
 * summary-marked turns plus the plain turns after it (that generation's former
 * keep-N). The markers survive copying, so the boundaries are already in the
 * data. Collapsing an era:
 *   - copies its USER rows whole, in order (the human's words are never
 *     touched — v1 behaviour)
 *   - writes the era's full original rows to the omission cache under ONE
 *     era Content ID (demote, never delete)
 *   - emits ONE stub row: era-authored DIAGNOSTIC text (it discriminates this
 *     era from the others — Goh & Lu 2012: diagnosticity, not fidelity),
 *     pinned verbatims exact, span, turn count, Content ID
 *   - drops everything else from the transcript
 *
 * AUTHORSHIP: the session authors its OWN eras. An era stub is the most
 * fragile representation in the pipeline — it is the last form the material
 * takes — so the text comes from the live session via tiered-eras.json,
 * never from a cold worker. Cold workers are the fallback for sessions that
 * can no longer run the command themselves.
 *
 * Era stubs are deliberately NOT marked as summary rows (a summary marker
 * moves the recompaction boundary — see createScaffoldStubRow). They carry
 * `tieredCompact.era`, which also marks the era as already collapsed: a
 * collapsed era is never a candidate again.
 */
import { randomUUID } from "node:crypto";
import { allocateOmission } from "./omission";
import { isRecord, type TranscriptRow, type Turn } from "./transcript";
import { turnKey } from "./summaries";

type OmissionCache = Parameters<typeof allocateOmission>[0];

export type Era = {
  /** turnKey of the era's first turn — the key era texts are filed under. */
  key: string;
  turns: Turn[];
  firstTimestamp: string;
  lastTimestamp: string;
  alreadyCollapsed: boolean;
};

// Accepts either marker; see the note in compact.ts. Not Claude Code's own
// `isCompactSummary` field, which is a different thing entirely.
function isCompactSummaryRow(row: TranscriptRow): boolean {
  for (const field of ["tieredCompact", "magicCompact"]) {
    const marker = row[field];
    if (isRecord(marker) && marker["summary"] === true) {
      return true;
    }
  }
  return false;
}

export function isEraStubRow(row: TranscriptRow): boolean {
  const tieredCompact = row["tieredCompact"];
  return isRecord(tieredCompact) && isRecord(tieredCompact["era"]);
}

function turnHasSummaryRow(turn: Turn): boolean {
  return turn.rows.some(isCompactSummaryRow);
}

/** The generation tag of a turn's summary rows, if any ("" = untagged). */
function turnGeneration(turn: Turn): string | null {
  for (const row of turn.rows) {
    if (!isCompactSummaryRow(row)) continue;
    const tieredCompact = row["tieredCompact"];
    if (isRecord(tieredCompact) && typeof tieredCompact["gen"] === "string") {
      return tieredCompact["gen"];
    }
    return "";
  }
  return null;
}

function turnHasEraStub(turn: Turn): boolean {
  return turn.rows.some(isEraStubRow);
}

function turnTimestamps(turn: Turn): string[] {
  return turn.rows.map(row => row.timestamp).filter(Boolean) as string[];
}

/**
 * Split prefix turns into eras. A new era begins where a summary-run begins
 * (a summary-marked turn whose predecessor is not summary-marked). Material
 * before the first summary-run — the recursively oldest inheritance — is its
 * own era. Eras are returned oldest first.
 */
export function splitPrefixIntoEras(prefixTurns: Turn[]): Era[] {
  const eras: Era[] = [];
  let current: Turn[] = [];
  let previousWasSummary = false;
  let previousGen: string | null = null;
  for (const turn of prefixTurns) {
    const isSummary = turnHasSummaryRow(turn);
    const gen = turnGeneration(turn);
    // Split where a summary run begins, AND where the generation tag changes
    // inside a run — adjacency merges runs, but tags survive copying, so
    // tagged generations stay separable forever.
    const genChanged =
      isSummary && previousWasSummary && gen !== null && gen !== previousGen;
    if ((isSummary && !previousWasSummary && current.length > 0) || (genChanged && current.length > 0)) {
      eras.push(buildEra(current));
      current = [];
    }
    current.push(turn);
    previousWasSummary = isSummary;
    if (gen !== null) previousGen = gen;
    // A stub is a fossilized era boundary: it marks where a prior collapse
    // ended. Splitting after it keeps era structure alive across passes —
    // without this, one summaries pass after an era pass fused the whole
    // prefix into a single 508-turn era and collapse could never run again
    // (observed live 2026-08-27 on the first real two-pass lineage).
    if (turnHasEraStub(turn)) {
      eras.push(buildEra(current));
      current = [];
      previousWasSummary = false;
    }
  }
  if (current.length > 0) {
    eras.push(buildEra(current));
  }
  return eras;
}

function buildEra(turns: Turn[]): Era {
  const stamps = turns.flatMap(turnTimestamps).sort();
  return {
    key: turnKey(turns[0]!),
    turns,
    firstTimestamp: stamps[0] ?? "",
    lastTimestamp: stamps[stamps.length - 1] ?? "",
    alreadyCollapsed: turns.some(turnHasEraStub),
  };
}

/**
 * The eras eligible for collapse under `--eras K`: all but the newest K,
 * excluding eras already collapsed. Oldest first, preserving order.
 */
export function collapseCandidates(eras: Era[], keepNewest: number): Era[] {
  const cutoff = Math.max(0, eras.length - Math.max(1, keepNewest));
  // An era is re-collapsible: prior stubs ride whole through the user-row
  // path and a new stub covers the newly collapsed mass. The only skip is an
  // era with nothing left to collapse — all its rows already survive whole
  // (user rows, human-words attachments, stubs). The old rule here — "any
  // era containing a stub is done" — poisoned the whole containing era the
  // moment transcript structure re-merged, making mature lineages permanently
  // immune to the one pass built for them.
  return eras.slice(0, cutoff).filter(era => eraHasCollapsibleMass(era));
}

function eraHasCollapsibleMass(era: Era): boolean {
  for (const turn of era.turns) {
    for (const row of turn.rows) {
      if (turn.userRows.includes(row)) continue;
      if (isEraStubRow(row)) continue;
      const attachment = row["attachment"];
      if (isRecord(attachment)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Serialize an era's full original rows for the omission cache. JSONL — the
 * same shape the transcript itself uses, so retrieval hands back rows that
 * can be read, grepped, or replayed without a decoder.
 */
export function serializeEra(era: Era): string {
  return era.turns
    .flatMap(turn => turn.rows)
    .map(row => JSON.stringify(row))
    .join("\n");
}

export function createEraStubRow(
  era: Era,
  stubText: string,
  contentId: string,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
  baseRow: TranscriptRow,
): TranscriptRow {
  const span =
    `${era.firstTimestamp.slice(0, 10)} → ${era.lastTimestamp.slice(0, 10)}`;
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    timestamp,
    isMeta: true,
    cwd: baseRow["cwd"],
    version: baseRow["version"],
    message: {
      id: `msg_${randomUUID()}`,
      role: "user",
      content:
        `[era ${span} · ${era.turns.length} turns · full rows: `
        + `read_omitted_content("${contentId}")]\n${stubText}`,
    },
    tieredCompact: {
      era: {
        contentId,
        turns: era.turns.length,
        span: [era.firstTimestamp, era.lastTimestamp],
      },
    },
  } as unknown as TranscriptRow;
}

/** Write one era to the cache; returns its Content ID. */
export function allocateEra(
  cache: OmissionCache,
  sessionId: string,
  era: Era,
): string {
  return allocateOmission(cache, sessionId, serializeEra(era));
}

// ---------------------------------------------------------------------------
// tiered-eras.json — the era-authoring contract (mode-B twin)
// ---------------------------------------------------------------------------
import { dirname, join } from "node:path";
import { rename } from "node:fs/promises";
import { stampMatchesLineage, transcriptId } from "./summaries";

export const ERAS_FILENAME = "tiered-eras.json";

export function erasPath(transcriptPath: string): string {
  return join(dirname(transcriptPath), ERAS_FILENAME);
}

export type ErasFile = {
  transcript?: string;
  eras: Record<string, string>;
  /** Row ids (origin keys) the author chose to carry as pointers; see channel.ts. */
  pointers?: string[];
};

export async function loadErasFile(
  transcriptPath: string,
): Promise<ErasFile | null> {
  const file = Bun.file(erasPath(transcriptPath));
  if (!(await file.exists())) {
    return null;
  }
  const parsed: unknown = JSON.parse(await file.text());
  if (
    !isRecord(parsed)
    || !isRecord(parsed["eras"])
    || !Object.values(parsed["eras"]).every(
      value => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    throw new Error(
      `${ERAS_FILENAME} is malformed: expected {"transcript": "<session id>", `
        + `"eras": {"<era key>": "<stub text>"}}.`,
    );
  }
  const stamp = parsed["transcript"];
  if (
    typeof stamp === "string"
    && !(await stampMatchesLineage(stamp, transcriptPath))
  ) {
    throw new Error(
      `${ERAS_FILENAME} was prepared for session ${stamp}, which is neither `
        + `this session (${transcriptId(transcriptPath)}) nor an ancestor `
        + "found in its transcript. Nothing was consumed. Run the command "
        + "from the session that authored it.",
    );
  }
  const pointers = parsed["pointers"];
  if (pointers !== undefined
      && !(Array.isArray(pointers) && pointers.every(id => typeof id === "string"))) {
    throw new Error(`${ERAS_FILENAME}: "pointers" must be a list of row ids.`);
  }
  return {
    transcript: typeof stamp === "string" ? stamp : undefined,
    eras: parsed["eras"] as Record<string, string>,
    ...(pointers === undefined ? {} : { pointers: pointers as string[] }),
  };
}

export async function retireErasFile(transcriptPath: string): Promise<void> {
  const path = erasPath(transcriptPath);
  await rename(path, `${path}.used`).catch(() => undefined);
}

export type EraWork = {
  /** All prefix eras in order; candidates carry their authored stub text. */
  eras: Era[];
  candidateKeys: Set<string>;
  texts: Record<string, string>;
  /** Rows to carry as pointers instead of whole, when channel.ts allows it. */
  pointers: Set<string>;
  /** Filled in during assembly: pointers carried, and listed typed rows refused. */
  tally: { applied: number; refused: number };
};

/**
 * Resolve the era work for a compaction: split, select candidates, demand a
 * text for every candidate. Missing texts are a hard error naming the keys —
 * assembly never proceeds partially curated (mode-B discipline).
 */
export function resolveEraWork(
  prefixTurns: Turn[],
  keepNewest: number,
  texts: Record<string, string>,
  pointers: readonly string[] = [],
): EraWork | null {
  const eras = splitPrefixIntoEras(prefixTurns);
  const candidates = collapseCandidates(eras, keepNewest);
  if (candidates.length === 0) {
    return null;
  }
  const missing = candidates.filter(era => !(era.key in texts));
  if (missing.length > 0) {
    throw new Error(
      `${ERAS_FILENAME} is missing ${missing.length} era(s): `
        + `${missing.map(era => era.key).slice(0, 5).join(", ")}`
        + `${missing.length > 5 ? ", …" : ""}. Author every candidate era, `
        + "then re-run.",
    );
  }
  return {
    eras,
    candidateKeys: new Set(candidates.map(era => era.key)),
    texts,
    pointers: new Set(pointers),
    tally: { applied: 0, refused: 0 },
  };
}
