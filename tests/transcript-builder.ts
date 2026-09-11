/**
 * Synthetic transcript builder, modelled on REAL session files.
 *
 * Shapes were read off two live transcripts in
 * ~/.claude/projects/<project-slug>/ (real session transcripts)
 * rather than invented, because the bug this harness exists to catch lives in
 * the parts of the format that are easy to get wrong:
 *
 *   - Metadata rows (`mode`, `permission-mode`, `last-prompt`, `custom-title`,
 *     `agent-name`) carry NO uuid and are not conversation. In the measured file the
 *     1,193 rows before the compaction boundary were ALL of this kind — they
 *     look like lost history in a naive row count and are nothing of the sort.
 *   - The boundary row is `type: "user"` with `isMeta: true`,
 *     `magicCompact: {boundary: true}`, `parentUuid: null`, and a
 *     `logicalParentUuid` that points at a PRE-COPY uuid — i.e. it dangles in
 *     the file it is written into.
 *   - Real transcripts BRANCH. The measured file had 144 leaf rows; the active chain
 *     from the newest leaf reached 542 of 4,286 conversation rows (13%). The
 *     other 3,744 were off-chain — present in the file, invisible to the
 *     planner. That is the actual mechanism behind "the founding vanished",
 *     not parentless rows and not the boundary slice.
 *
 * Everything here emits rows that satisfy transcript.ts's isTranscriptRow
 * (uuid + type) and isHumanUserRow (user, non-tool-result, isMeta !== true).
 */
import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../plugins/riverbed-compact/src/transcript";

export const SESSION_ID = "synthetic-source-session";

let clock = 0;
function nextTimestamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 6, 30, 0, 0, 0, clock)).toISOString();
}

/** Reset the clock so tests are order-independent. */
export function resetClock(): void {
  clock = 0;
}

const COMMON = {
  isSidechain: false,
  userType: "external",
  entrypoint: "cli",
  cwd: "/home/user/project",
  version: "2.1.220",
  gitBranch: "master",
  sessionKind: "bg",
};

export function userRow(text: string, parentUuid: string | null): JsonRecord {
  return {
    ...COMMON,
    parentUuid,
    promptId: randomUUID(),
    type: "user",
    uuid: randomUUID(),
    timestamp: nextTimestamp(),
    sessionId: SESSION_ID,
    message: { role: "user", content: text },
  };
}

export function assistantRow(
  text: string,
  parentUuid: string | null,
  extra: JsonRecord = {},
): JsonRecord {
  return {
    ...COMMON,
    parentUuid,
    requestId: `req_${randomUUID()}`,
    type: "assistant",
    uuid: randomUUID(),
    timestamp: nextTimestamp(),
    sessionId: SESSION_ID,
    message: {
      model: "claude-fable-5",
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    ...extra,
  };
}

/** An assistant row carrying one tool_use block — the shape that dominates
 * real transcripts and the one the prefix era was reproducing fat forever. */
export function toolUseRow(
  name: string,
  toolUseId: string,
  input: JsonRecord,
  parentUuid: string,
): JsonRecord {
  return {
    ...COMMON,
    parentUuid,
    requestId: `req_${randomUUID()}`,
    type: "assistant",
    uuid: randomUUID(),
    timestamp: nextTimestamp(),
    sessionId: SESSION_ID,
    message: {
      model: "claude-fable-5",
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
  };
}

/** The matching tool_result. A user row, but NOT a human one — it must never
 * open a new turn, which is what makes tool I/O belong to the turn above it. */
export function toolResultRow(
  toolUseId: string,
  content: unknown,
  parentUuid: string,
): JsonRecord {
  return {
    ...COMMON,
    parentUuid,
    type: "user",
    uuid: randomUUID(),
    timestamp: nextTimestamp(),
    sessionId: SESSION_ID,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

/** The compaction boundary row, with the dangling logicalParentUuid intact. */
export function boundaryRow(logicalParentUuid: string): JsonRecord {
  return {
    ...COMMON,
    parentUuid: null,
    promptId: randomUUID(),
    type: "user",
    uuid: randomUUID(),
    timestamp: nextTimestamp(),
    sessionId: SESSION_ID,
    isMeta: true,
    message: {
      role: "user",
      content: "<post-compaction-notice>\nA compaction operation has just been "
        + "applied to all messages above.\n</post-compaction-notice>",
    },
    logicalParentUuid,
    magicCompact: { boundary: true },
  };
}

/** Session metadata — no uuid, not conversation. 1,193 of these fooled us once. */
export function metadataRows(count: number): JsonRecord[] {
  const kinds: JsonRecord[] = [
    { type: "mode", mode: "default", sessionId: SESSION_ID },
    { type: "permission-mode", permissionMode: "default", sessionId: SESSION_ID },
    { type: "last-prompt", lastPrompt: "…", leafUuid: randomUUID(), sessionId: SESSION_ID },
    { type: "custom-title", customTitle: "example", sessionId: SESSION_ID },
    { type: "agent-name", agentName: "worker-1", sessionId: SESSION_ID },
  ];
  return Array.from({ length: count }, (_, i) => ({ ...kinds[i % kinds.length]! }));
}

export type TurnSpec = {
  /** Text of the human turn — use a unique marker so it can be traced. */
  user: string;
  /** Text of the assistant reply. */
  assistant: string;
  /** Optional tool call inside the turn: one tool_use row and its tool_result.
   * Both hang below the assistant text row, so they belong to this turn. */
  tool?: { name: string; input: JsonRecord; output: unknown };
  /**
   * Mark this turn's assistant text row as the output of a PRIOR compaction
   * (`magicCompact: {summary: true}`). createPlan treats everything up to and
   * including the last such turn as the prefix era, so this is how a test
   * builds a transcript that already has history behind it.
   */
  priorSummary?: boolean;
};

export type BuildSpec = {
  /** Turns on the main (newest-leaf) branch. */
  turns: TurnSpec[];
  /** Metadata rows emitted before anything else, as real sessions do. */
  metadata?: number;
  /**
   * Insert a compaction boundary after this many main-branch turns.
   * The boundary's logicalParentUuid deliberately dangles, as in real files.
   */
  boundaryAfterTurn?: number;
  /**
   * Turns written as a SEPARATE BRANCH hanging off the given main-branch turn
   * index. These are real conversation rows, present in the file, but off the
   * newest-leaf chain — the exact shape that made a founding conversation
   * invisible to the planner.
   */
  branch?: { afterTurn: number; turns: TurnSpec[] };
};

export type BuiltTranscript = {
  entries: JsonRecord[];
  /** Marker strings for every non-scaffold turn, in emission order. */
  markers: string[];
  /** Markers that live on the off-chain branch, if any. */
  branchMarkers: string[];
};

export function buildTranscript(spec: BuildSpec): BuiltTranscript {
  const entries: JsonRecord[] = [...metadataRows(spec.metadata ?? 0)];
  const markers: string[] = [];
  const branchMarkers: string[] = [];
  const mainTurnLastUuid: string[] = [];

  let parent: string | null = null;

  spec.turns.forEach((turn, index) => {
    if (spec.boundaryAfterTurn === index) {
      // logicalParentUuid names the last row of the SOURCE transcript, whose
      // copies were all re-minted on the way in — so it dangles in the file it
      // is written into. randomUUID() reproduces that faithfully; passing a
      // uuid that actually resolves would make the builder kinder than reality
      // and hide the fact that this pointer cannot be used to cross the seam.
      const boundary = boundaryRow(randomUUID());
      entries.push(boundary);
      parent = boundary["uuid"] as string;
    }
    const u = userRow(turn.user, parent);
    entries.push(u);
    const a = assistantRow(
      turn.assistant,
      u["uuid"] as string,
      turn.priorSummary ? { magicCompact: { summary: true } } : {},
    );
    entries.push(a);
    parent = a["uuid"] as string;
    if (turn.tool) {
      const toolUseId = `toolu_${randomUUID()}`;
      const tu = toolUseRow(turn.tool.name, toolUseId, turn.tool.input, parent);
      entries.push(tu);
      const tr = toolResultRow(
        toolUseId,
        turn.tool.output,
        tu["uuid"] as string,
      );
      entries.push(tr);
      parent = tr["uuid"] as string;
    }
    markers.push(turn.user, turn.assistant);
    mainTurnLastUuid.push(parent);
  });

  if (spec.branch) {
    // Hang a second branch off an EARLIER main-branch turn. Its rows are
    // conversation, are in the file, and are unreachable from the newest leaf.
    let bParent: string | null = mainTurnLastUuid[spec.branch.afterTurn] ?? null;
    for (const turn of spec.branch.turns) {
      const u = userRow(turn.user, bParent);
      entries.push(u);
      const a = assistantRow(turn.assistant, u["uuid"] as string);
      entries.push(a);
      bParent = a["uuid"] as string;
      branchMarkers.push(turn.user, turn.assistant);
    }
  }

  return { entries, markers, branchMarkers };
}

export async function writeTranscript(
  path: string,
  entries: JsonRecord[],
): Promise<void> {
  await Bun.write(path, `${entries.map(e => JSON.stringify(e)).join("\n")}\n`);
}

export async function readEntries(path: string): Promise<JsonRecord[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter(line => line.trim() !== "")
    .map(line => JSON.parse(line) as JsonRecord);
}

/** All text anywhere in an entry, for presence assertions. */
export function entryText(entry: JsonRecord): string {
  return JSON.stringify(entry);
}

export function transcriptText(entries: JsonRecord[]): string {
  return entries.map(entryText).join("\n");
}

/** Write a summaries file next to a transcript, keyed by first-row uuid. */
export async function writeSummaries(
  transcriptPath: string,
  summaries: Record<string, string>,
): Promise<void> {
  const dir = transcriptPath.slice(0, transcriptPath.lastIndexOf("/"));
  await Bun.write(
    `${dir}/riverbed-summaries.json`,
    `${JSON.stringify({ summaries }, null, 2)}\n`,
  );
}
