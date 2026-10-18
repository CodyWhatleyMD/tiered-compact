import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export type TranscriptRow = JsonRecord & {
  type: "user" | "assistant" | "attachment" | "system";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message?: JsonRecord;
  /** `"compact_boundary"` on Claude Code's own native compaction marker row. */
  subtype?: string;
  /** Set by Claude Code's native /compact on its recap row. See isHumanUserRow. */
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  /**
   * The uuid this row had when it was FIRST written, carried unchanged through
   * every subsequent compaction (see copyRow). `uuid` is re-minted on each
   * copy, which silently orphaned every summary keyed to it — summaries.ts
   * documented "uuids never change" as an invariant that compact.ts violated.
   * Absent on rows that have never been through a compaction; in that case the
   * origin identity IS `uuid`. Always read it via originKey().
   */
  originUuid?: string;
};

/** A row's stable cross-compaction identity. */
export function originKey(row: TranscriptRow): string {
  return typeof row.originUuid === "string" && row.originUuid !== ""
    ? row.originUuid
    : row.uuid;
}

export type TranscriptCopy = {
  sessionId: string;
  transcriptPath: string;
};

export type Turn = {
  userRows: TranscriptRow[];
  rows: TranscriptRow[];
};

/**
 * Rows the current context is built from.
 *
 * Default (`reachPastBoundary: false`): the single newest root-to-leaf chain
 * after the last compaction boundary. Correct for "what is live right now",
 * and what every caller wanted before 2026-07-30.
 *
 * It is NOT correct for deciding what to CARRY FORWARD, because real
 * transcripts branch. Measured on a real 7.4MB transcript: 8 conversation leaves, one chain reaches
 * 541 of 4,286 rows under isTranscriptRow's set (user+assistant+attachment+
 * system) or 308 of 3,489 user+assistant rows. Everything else sits in another
 * component and is dropped silently, while plan.ts reports full coverage
 * because it counts only what it was handed. That is how a founding
 * conversation went missing on 2026-07-30 — at row 3355, present in the file
 * the whole time, on a branch the walk never took.
 *
 * CORPUS SCALE — state the basis or the number lies (red-teamed 2026-07-30):
 *   29,765 user+assistant rows (19.21%) are off the single-chain walk, BUT
 *   64.6% of those carry no prose at all (tool_result 23.4%, tool_use 23.1%,
 *   thinking 18.1%). Prose-bearing: 10,540 rows / 2.02M chars. Under a
 *   connected-COMPONENT definition rather than single-chain it is 25,098 rows
 *   (16.20%). Char counts must name their extraction: 7.52M counts `text`
 *   blocks only; the same rows with every block type are 35.95M.
 *   None of it was ever at risk of LOSS — it is in the .jsonl and a linear read
 *   returns it. The risk is silent omission from a compaction.
 *   (An earlier version of this comment said "144 leaf rows"; 144 is
 *   terminalRows, of which 139 are attachment rows and 1 is system.)
 *
 * (Two wrong diagnoses are buried here; both are refuted in stepToParent. The
 * rows before the boundary are session METADATA — mode, permission-mode,
 * last-prompt, custom-title, agent-name — with no uuid and no message content.
 * They are correctly filtered by readTranscriptRows and were never lost.)
 *
 * `reachPastBoundary: true` collects EVERY component, ordered by earliest
 * timestamp (file order and timestamp order agreed in 19/19 multi-component
 * transcripts). Safe to READ with. NOT yet safe to compact with: compact.ts
 * copies prefixTurns verbatim, so that transcript would carry a 7.4MB prefix into
 * every subsequent session and grow monotonically. Summarize or prune the
 * prefix before wiring this into the compaction path.
 */
export async function readActiveTranscriptRows(
  transcriptPath: string,
  options: { reachPastBoundary?: boolean } = {},
): Promise<TranscriptRow[]> {
  const rows = await readTranscriptRows(transcriptPath);
  if (options.reachPastBoundary === true) {
    return buildActiveChain(rows, true);
  }
  const lastBoundaryIndex = rows.findLastIndex(isCompactBoundary);
  return buildActiveChain(
    lastBoundaryIndex === -1 ? rows : rows.slice(lastBoundaryIndex + 1),
  );
}

export async function copyTranscriptToNewSession(
  sourceTranscriptPath: string,
): Promise<TranscriptCopy> {
  const destination = await createTranscriptSession(sourceTranscriptPath);
  await copyFile(
    sourceTranscriptPath,
    destination.transcriptPath,
    constants.COPYFILE_EXCL,
  );
  return destination;
}

export async function createTranscriptSession(
  sourceTranscriptPath: string,
): Promise<TranscriptCopy> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const sessionId = randomUUID();
    const transcriptPath = join(
      dirname(sourceTranscriptPath),
      `${sessionId}.jsonl`,
    );

    try {
      await access(transcriptPath, constants.F_OK);
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") {
        return { sessionId, transcriptPath };
      }

      throw error;
    }
  }

  throw new Error("Unable to create a unique transcript session.");
}

export async function readPreservedMetadataEntries(
  transcriptPath: string,
  sourceSessionId: string,
  destinationSessionId: string,
): Promise<JsonRecord[]> {
  const entries = await readTranscriptEntries(transcriptPath);
  return entries
    .filter(
      (entry): entry is JsonRecord =>
        isRecord(entry)
        && !isTranscriptRow(entry)
        && isPreservedMetadataEntry(entry),
    )
    .map(entry =>
      rewriteSessionMetadata(entry, sourceSessionId, destinationSessionId),
    );
}

export async function writeTranscriptEntries(
  transcriptPath: string,
  entries: JsonRecord[],
): Promise<void> {
  await Bun.write(
    transcriptPath,
    `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
  );
}

export async function readTranscriptRows(
  transcriptPath: string,
): Promise<TranscriptRow[]> {
  const entries = await readTranscriptEntries(transcriptPath);
  return entries.filter(isTranscriptRow);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export function buildAssistantTurns(rows: TranscriptRow[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let assistantStarted = false;

  for (const row of rows) {
    if (isHumanUserRow(row)) {
      if (!currentTurn || assistantStarted) {
        currentTurn = { userRows: [], rows: [] };
        turns.push(currentTurn);
        assistantStarted = false;
      }
      currentTurn.userRows.push(row);
      currentTurn.rows.push(row);
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    currentTurn.rows.push(row);
    if (row.type === "assistant" || isToolResultRow(row)) {
      assistantStarted = true;
    }
  }

  return turns.filter(turn =>
    turn.rows.some(row => row.type === "assistant" || isToolResultRow(row)),
  );
}

/**
 * Step to a row's parent. `parentUuid` only — never `logicalParentUuid`.
 *
 * An earlier version of this function fell back to `logicalParentUuid` when
 * `parentUuid` was null, on the theory that the boundary row's null parent was
 * what severed history. That theory was wrong twice over:
 *
 *  1. History is not severed at the boundary. Transcripts BRANCH — the measured transcript has
 *     8 conversation leaves — and a single root-to-leaf walk reached 308 of its
 *     3,489 user+assistant rows. Reachability, not severance. buildActiveChain's
 *     component collection is the actual fix.
 *  2. `logicalParentUuid` is a CROSS-SESSION pointer: it names the last row of
 *     the SOURCE transcript, which is why it correctly never resolves in the
 *     file it is written into (36/36 boundaries, corpus-wide). It encodes the
 *     session lineage — each compaction linking to its predecessor — and is the only
 *     backward link between sessions there is.
 *
 * So the fallback was inert here and a live hazard anywhere it DID resolve: it
 * would splice a predecessor session's rows into the current chain. Do not
 * reintroduce it. To cross sessions, follow the lineage deliberately, file to
 * file — don't let a graph walk wander across it by accident.
 */
function stepToParent(
  row: TranscriptRow,
  rowsByUuid: Map<string, TranscriptRow>,
): TranscriptRow | undefined {
  return row.parentUuid ? rowsByUuid.get(row.parentUuid) : undefined;
}

function buildActiveChain(
  rows: TranscriptRow[],
  reachPastBoundary = false,
): TranscriptRow[] {
  const rowsByUuid = new Map(rows.map(row => [row.uuid, row]));
  const parentUuids = new Set(
    rows
      .map(row => row.parentUuid)
      .filter((uuid): uuid is string => uuid !== null),
  );
  const terminalRows = rows.filter(row => !parentUuids.has(row.uuid));
  const hasUserAssistantChild = new Set<string>();
  for (const row of rows) {
    if (
      row.parentUuid !== null
      && (row.type === "user" || row.type === "assistant")
    ) {
      hasUserAssistantChild.add(row.parentUuid);
    }
  }

  // Every branch-terminating conversation row — one per disconnected component.
  const leaves: TranscriptRow[] = [];
  for (const terminal of terminalRows) {
    const walked = new Set<string>();
    let current: TranscriptRow | undefined = terminal;
    while (current) {
      if (walked.has(current.uuid)) {
        throw new Error("Cycle detected in transcript parentUuid chain.");
      }
      walked.add(current.uuid);
      if (current.type === "user" || current.type === "assistant") {
        if (!hasUserAssistantChild.has(current.uuid)) {
          leaves.push(current);
        }
        break;
      }
      current = stepToParent(current, rowsByUuid);
    }
  }
  if (leaves.length === 0) {
    return [];
  }

  /**
   * Default keeps the historical selection exactly: the single newest leaf,
   * first-encountered winning ties. That walks ONE component.
   *
   * A transcript that has been through a compaction holds more than one: the
   * replayed history hangs off the boundary row (parentUuid null) while the
   * live conversation hangs off its own dangling root, and nothing links them.
   * Measured on a real transcript (2026-07-30), user+assistant rows only: 3,489 in
   * exactly 2 components — 3,181 of replayed history containing the founding,
   * and 308 of live conversation. Picking the newest leaf walked the live 308
   * and the founding was never traversed. Not lost, not summarized away —
   * standing in a tree nobody visited.
   *
   * State the row set with every count here. isTranscriptRow admits attachment
   * and system rows too, which is why the same file is also truthfully "541 of
   * 4,286". Two numbers 47% apart both labelled "conversation rows" is how this
   * comment and its own commit message ended up contradicting each other.
   */
  const selected = reachPastBoundary
    ? leaves
    : [
        leaves.reduce((best, leaf) =>
          leaf.timestamp.localeCompare(best.timestamp) > 0 ? leaf : best,
        ),
      ];

  const seen = new Set<string>();
  const chains: TranscriptRow[][] = [];
  for (const leaf of selected) {
    const chain: TranscriptRow[] = [];
    const walked = new Set<string>();
    let current: TranscriptRow | undefined = leaf;
    while (current) {
      if (walked.has(current.uuid)) {
        throw new Error("Cycle detected in transcript parentUuid chain.");
      }
      walked.add(current.uuid);
      // Already claimed by an earlier component: stop rather than duplicate.
      if (seen.has(current.uuid)) {
        break;
      }
      seen.add(current.uuid);
      chain.push(current);
      current = stepToParent(current, rowsByUuid);
    }
    if (chain.length > 0) {
      chains.push(chain.reverse());
    }
  }

  // Components are ordered by their earliest row. Sound when their time ranges
  // are disjoint, which is what a compaction produces (replay strictly precedes
  // what follows it). Overlapping ranges would interleave wrongly — see
  // componentSpansOverlap, which the caller can use to detect that case.
  chains.sort((a, b) => a[0]!.timestamp.localeCompare(b[0]!.timestamp));

  return recoverParallelToolRows(rows, chains.flat(), seen);
}

/**
 * True when two reconstructed components cover overlapping time ranges, i.e.
 * concatenating them by timestamp would interleave two live threads rather
 * than append history to the present. Compaction output does not do this; a
 * merged or hand-edited transcript might.
 */
export function componentSpansOverlap(chains: TranscriptRow[][]): boolean {
  const spans = chains
    .filter(chain => chain.length > 0)
    .map(chain => [chain[0]!.timestamp, chain[chain.length - 1]!.timestamp])
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0]!.localeCompare(spans[i - 1]![1]!) < 0) {
      return true;
    }
  }
  return false;
}

function recoverParallelToolRows(
  rows: TranscriptRow[],
  chain: TranscriptRow[],
  seen: Set<string>,
): TranscriptRow[] {
  const inserts = new Map<string, TranscriptRow[]>();
  const processedMessageIds = new Set<string>();
  const assistantRows = chain.filter(row => row.type === "assistant");
  const anchorByMessageId = new Map<string, TranscriptRow>();
  for (const assistant of assistantRows) {
    const messageId = getMessageId(assistant);
    if (messageId) {
      anchorByMessageId.set(messageId, assistant);
    }
  }

  for (const assistant of assistantRows) {
    const messageId = getMessageId(assistant);
    if (!messageId || processedMessageIds.has(messageId)) {
      continue;
    }
    processedMessageIds.add(messageId);

    const siblings = rows.filter(
      row =>
        row.type === "assistant"
        && getMessageId(row) === messageId
        && !seen.has(row.uuid),
    );
    const toolResults = rows.filter(
      row =>
        isToolResultRow(row)
        && row.parentUuid !== null
        && (row.parentUuid === assistant.uuid
          || siblings.some(sibling => sibling.uuid === row.parentUuid))
        && !seen.has(row.uuid),
    );

    if (siblings.length > 0 || toolResults.length > 0) {
      siblings.sort(compareByTimestamp);
      toolResults.sort(compareByTimestamp);
      const anchor = anchorByMessageId.get(messageId) ?? assistant;
      inserts.set(anchor.uuid, [...siblings, ...toolResults]);
      for (const row of [...siblings, ...toolResults]) {
        seen.add(row.uuid);
      }
    }
  }

  return chain.flatMap(row => [row, ...(inserts.get(row.uuid) ?? [])]);
}

function compareByTimestamp(a: TranscriptRow, b: TranscriptRow): number {
  return a.timestamp.localeCompare(b.timestamp);
}

// The `magicCompact` row markers are intentionally kept under the original
// field name so sessions compacted by the upstream Magic Compact plugin and
// by Tiered Compact remain mutually recompactable.
function isCompactBoundary(row: TranscriptRow): boolean {
  for (const field of ["tieredCompact", "magicCompact"]) {
    const marker = row[field];
    if (isRecord(marker) && marker["boundary"] === true) {
      return true;
    }
  }
  return false;
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== "user" || !isRecord(row.message)) {
    return false;
  }
  const content = row.message["content"];
  return (
    Array.isArray(content)
    && content.some(block => isRecord(block) && block["type"] === "tool_result")
  );
}

/**
 * Claude Code's OWN /compact writes its recap as `type:"user"` with
 * `isCompactSummary:true` and NO `isMeta` — so it passed all three tests here
 * and entered the curated layer as if the human had typed it. compact.ts then
 * re-copies user rows byte-faithfully through every later compaction, which
 * pins a generic auto-summary in the one tier that never compresses, forever.
 *
 * Measured before fixing: one session on this machine holds four native
 * compactions at 18.5k, 18.4k, 19.5k and 22.5k characters — ~79k of machine
 * recap that would ride as human speech. Another transcript already carries
 * one with an `originUuid`, i.e. it was copied THROUGH a tiered-compact pass.
 *
 * It is still summarizable content — it just is not the human's words, and the
 * whole point of this plugin is that the generic recap is the thing being
 * displaced, not the thing being enshrined.
 *
 * NB: `isCompactSummary` (Claude Code's field, this one) is NOT the same as the
 * local `isCompactSummaryRow` helpers in compact.ts/merge.ts/eras.ts, which
 * read our own `magicCompact.summary` marker.
 */
function isNativeCompactRecap(row: TranscriptRow): boolean {
  return row.type === "user" && row["isCompactSummary"] === true;
}

/**
 * A `type:"user"` row the SYSTEM wrote, not the human.
 *
 * When an Agent/Task worker finishes, Claude Code writes its full final report
 * into the parent transcript as a `type:"user"` row with string content
 * `<task-notification>…<result>…</result></task-notification>`,
 * `origin.kind:"task-notification"`, `promptSource:"system"`, and NO `isMeta`
 * — so it passed every test below and was treated as the human's words.
 *
 * That is the worst possible misclassification for this plugin, because a
 * compaction dispatches workers: the compaction's OWN subagent reports were being
 * copied byte-faithfully into the tier that never compresses, and re-copied
 * through every later generation. Counted on one machine: 5,538 such rows.
 *
 * The field census that settled the predicate, over 70,823 non-meta
 * string-content user rows:
 *   promptSource  typed 37,165 · (absent) 21,681 · system 5,538 ·
 *                 queued 5,119 · suggestion_accepted 944 · sdk 376
 *   origin.kind   human 43,275 · (absent) 22,004 · task-notification 5,544
 * `system` and `task-notification` select the same rows. Absent means an older
 * row from before the field existed, so absence must read as human. `sdk` is a
 * programmatic caller standing in for the user — kept.
 */
function isSystemAuthoredUserRow(row: TranscriptRow): boolean {
  if (row.type !== "user") {
    return false;
  }
  const origin = row["origin"];
  if (isRecord(origin) && origin["kind"] === "task-notification") {
    return true;
  }
  return row["promptSource"] === "system";
}

function isHumanUserRow(row: TranscriptRow): boolean {
  return (
    row.type === "user"
    && !isToolResultRow(row)
    && row.isMeta !== true
    && !isNativeCompactRecap(row)
    && !isSystemAuthoredUserRow(row)
  );
}

function getMessageId(row: TranscriptRow): string | null {
  return isRecord(row.message) && typeof row.message["id"] === "string"
    ? row.message["id"]
    : null;
}

function isTranscriptRow(value: unknown): value is TranscriptRow {
  return (
    isRecord(value)
    && typeof value["uuid"] === "string"
    && (value["type"] === "user"
      || value["type"] === "assistant"
      || value["type"] === "attachment"
      || value["type"] === "system")
  );
}

async function readTranscriptEntries(
  transcriptPath: string,
): Promise<unknown[]> {
  const content = await readFile(transcriptPath, "utf8");
  return content
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => JSON.parse(line) as unknown);
}

function isPreservedMetadataEntry(entry: JsonRecord): boolean {
  return PRESERVED_METADATA_TYPES.has(String(entry["type"]));
}

function rewriteSessionMetadata(
  entry: JsonRecord,
  sourceSessionId: string,
  destinationSessionId: string,
): JsonRecord {
  const copied = structuredClone(entry) as JsonRecord;
  if (copied["sessionId"] === sourceSessionId) {
    copied["sessionId"] = destinationSessionId;
  }
  return copied;
}

const PRESERVED_METADATA_TYPES = new Set([
  "custom-title",
  "ai-title",
  "last-prompt",
  "tag",
  "agent-name",
  "agent-color",
  "agent-setting",
  "mode",
  "worktree-state",
  "pr-link",
  "task-summary",
  "permission-mode",
]);

export async function resolveSessionTitle(
  transcriptPath: string,
): Promise<string | null> {
  const entries = await readTranscriptEntries(transcriptPath);
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      entry["type"] === "custom-title"
      && typeof entry["customTitle"] === "string"
    ) {
      customTitle = entry["customTitle"];
    } else if (
      entry["type"] === "ai-title"
      && typeof entry["aiTitle"] === "string"
    ) {
      aiTitle = entry["aiTitle"];
    }
  }
  return customTitle ?? aiTitle;
}

export async function appendCustomTitle(
  transcriptPath: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const entry = {
    type: "custom-title",
    customTitle: title,
    sessionId,
  };
  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
  });
}
