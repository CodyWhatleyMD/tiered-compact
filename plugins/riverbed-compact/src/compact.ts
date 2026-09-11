import {
  allocateEra,
  createEraStubRow,
  isEraStubRow,
  resolveEraWork,
  type EraWork,
} from "./eras";
import { randomUUID } from "node:crypto";
import { loadOmissionCache, saveOmissionCache } from "./omission";
import { pruneTranscriptRow, type PruneContext } from "./prune";
import {
  SUMMARIES_FILENAME,
  loadSummariesFile,
  resolveSummariesFromFile,
  resolveTurnSummary,
  retireSummariesFile,
  type SummariesFile,
} from "./summaries";
import {
  buildAssistantTurns,
  isRecord,
  originKey,
  type JsonRecord,
  readActiveTranscriptRows,
  readPreservedMetadataEntries,
  type Turn,
  type TranscriptRow,
  writeTranscriptEntries,
} from "./transcript";

export type Plan = {
  prefixTurns: Turn[];
  summarizedTurns: Turn[];
  preservedTurns: Turn[];
  baseRow: TranscriptRow;
};

/**
 * Literal token that marks an assistant turn as scaffolding. When an
 * assistant turn's text contains this token, the rebuilt session drops the
 * assistant turn entirely (its user prompt is kept verbatim, everything the
 * assistant produced — text, thinking, tool I/O — is replaced by a one-line
 * stub), regardless of keep-N or any other rule. This lets deliberation
 * turns (the directive-writing turn itself, pre-compaction memory-writing
 * narration) cost zero in the compacted output.
 */
export const SCAFFOLD_MARKER = "[[riverbed:scaffold]]";

const SCAFFOLD_STUB_TEXT =
  "[A scaffolding turn was removed here by riverbed-compact.]";

const POST_COMPACTION_NOTICE = `<post-compaction-notice>
A compaction operation has just been applied to all messages above. You may have to reread certain files to regain context. Certain historical tool input/output may have been omitted due to length. If the exact I/O of the tool call needs to be retrieved and functionality cannot be replicated via a new tool call, call the read_omitted_content tool with the appropriate Content ID to reread the tool I/O content.
</post-compaction-notice>`;

/**
 * What a compaction actually did — an INVENTORY, not a verdict. A verdict
 * ("success") can be true while the cargo is on the floor: on 2026-08-27 an
 * assembly ran without a fully-authored eras file sitting next to the
 * transcript and printed success. An inventory cannot hide that zero: had it
 * printed "eras collapsed: 0", the omission would have announced itself in
 * the same breath. (A review rule, earned the hard way.)
 */
export type CompactionInventory = {
  summariesConsumed: number;
  erasCollapsed: number;
  prefixTurns: number;
  summarizedTurns: number;
  preservedTurns: number;
  rowsWritten: number;
  stamp: string;
};

export async function compactTranscript(
  sourceTranscriptPath: string,
  destinationTranscriptPath: string,
  sessionId: string,
  keepTurns: number | null,
  cwd: string | null = null,
  eras: { keepNewest: number; texts: Record<string, string> } | null = null,
): Promise<CompactionInventory | null> {
  const rows = await readActiveTranscriptRows(sourceTranscriptPath);
  const plan = createPlan(rows, keepTurns);
  const hasPreservedScaffolds = plan.preservedTurns.some(isScaffoldTurn);
  // Era-collapse is real work even when nothing needs summarizing — on a
  // mature lineage (prefix=533, summarized=0, preserved=7, measured
  // 2026-08-25) it is the ONLY work, and the reason the flag exists.
  const eraWork: EraWork | null =
    eras === null
      ? null
      : resolveEraWork(plan.prefixTurns, eras.keepNewest, eras.texts);
  if (
    plan.summarizedTurns.length === 0
    && !hasPreservedScaffolds
    && eraWork === null
  ) {
    return null;
  }

  const turnsToSummarize = plan.summarizedTurns.filter(
    turn => !isScaffoldTurn(turn),
  );
  // Mode B only: summaries are written by the live in-context instance into a
  // riverbed-summaries.json next to the transcript (see summaries.ts /
  // plan.ts). There is deliberately no headless-resume fallback — that path
  // cannot survive large transcripts ("Prompt is too long"), which is the
  // whole reason mode B exists. A missing file is a hard error, not a silent
  // retry that would discard curation or die on transcript size.
  const summariesFile = await loadSummariesFile(sourceTranscriptPath);
  if (summariesFile === null && turnsToSummarize.length > 0) {
    throw new Error(
      `No ${SUMMARIES_FILENAME} found next to the transcript, but `
        + `${turnsToSummarize.length} turn(s) need summaries. Run `
        + `/riverbed-compact N to receive authoring instructions (inline by `
        + `default; add --fork [K] or --subagent [K] to delegate), then re-run.`,
    );
  }
  // Boundary drift tolerance: turns that accrued after the summaries were
  // authored sit at the TAIL of the summarize-range with no coverage. Shift
  // that contiguous uncovered tail into the preserved region (they ride
  // whole — conservative, no curation discarded) instead of hard-failing on
  // an arithmetic race the author cannot win. Interior gaps remain errors.
  if (summariesFile !== null) {
    shiftUncoveredTail(plan, summariesFile);
  }
  const finalToSummarize = plan.summarizedTurns.filter(
    turn => !isScaffoldTurn(turn),
  );
  // Finding 3 (independent review): when a file covers NOTHING, the whole
  // summarize-range shifts into preserved, finalToSummarize hits 0, the
  // coverage check is skipped — and the file was then retired anyway. That
  // is the 2026-08-18 incident as a silent path: zero keys matched, nothing
  // assembled, the rightful session left with an empty shelf. A file that
  // matched nothing was not consumed; it was destroyed. Retirement is now
  // gated on at least one key having resolved to a turn.
  const summariesFileWasUsed =
    summariesFile !== null && finalToSummarize.length > 0;
  const summaries =
    finalToSummarize.length === 0
      ? []
      : resolveSummariesFromFile(summariesFile!, finalToSummarize);
  const compactedRows = await buildCompactedRows(
    plan,
    summaries,
    sessionId,
    eraWork,
  );
  const metadataEntries = await readPreservedMetadataEntries(
    sourceTranscriptPath,
    plan.baseRow.sessionId,
    sessionId,
  );
  await writeTranscriptEntries(destinationTranscriptPath, [
    ...metadataEntries,
    ...compactedRows,
  ]);
  if (summariesFileWasUsed) {
    await retireSummariesFile(sourceTranscriptPath);
  }
  return {
    summariesConsumed: summaries.length,
    erasCollapsed: eraWork === null ? 0 : eraWork.candidateKeys.size,
    prefixTurns: plan.prefixTurns.length,
    summarizedTurns: plan.summarizedTurns.length,
    preservedTurns: plan.preservedTurns.length,
    rowsWritten: metadataEntries.length + compactedRows.length,
    stamp: sessionId,
  };
}

/**
 * Move the contiguous uncovered tail of plan.summarizedTurns into
 * plan.preservedTurns. Walking from the end: scaffold turns never need
 * coverage so they move with the tail; the first covered non-scaffold turn
 * stops the walk. Mutates the plan in place.
 */
export function shiftUncoveredTail(plan: Plan, file: SummariesFile): void {
  let cut = plan.summarizedTurns.length;
  while (cut > 0) {
    const turn = plan.summarizedTurns[cut - 1]!;
    if (isScaffoldTurn(turn) || resolveTurnSummary(file, turn) === null) {
      cut -= 1;
    } else {
      break;
    }
  }
  // A scaffold-only suffix above a covered turn is not drift — leave it to
  // render as stubs in the summarized region, exactly as planned.
  while (
    cut < plan.summarizedTurns.length
    && isScaffoldTurn(plan.summarizedTurns[cut]!)
  ) {
    cut += 1;
  }
  if (cut < plan.summarizedTurns.length) {
    plan.preservedTurns = [
      ...plan.summarizedTurns.slice(cut),
      ...plan.preservedTurns,
    ];
    plan.summarizedTurns = plan.summarizedTurns.slice(0, cut);
  }
}

export function createPlan(
  rows: TranscriptRow[],
  keepTurns: number | null,
): Plan {
  const baseRow = rows.find(
    row => row.type === "user" || row.type === "assistant",
  );
  if (!baseRow) {
    throw new Error(
      "Transcript does not contain compactable conversation rows.",
    );
  }

  const turns = buildAssistantTurns(rows);
  const compactionStartIndex =
    turns.findLastIndex(turn => turn.rows.some(isCompactSummaryRow)) + 1;
  // null = no N given: preserve the whole live bed (an eras-only pass).
  // 0 = the user explicitly asked to summarize everything.
  const compactionEndIndex =
    keepTurns === null
      ? compactionStartIndex
      : keepTurns <= 0
        ? turns.length
        : Math.max(compactionStartIndex, turns.length - keepTurns);

  return {
    prefixTurns: turns.slice(0, compactionStartIndex),
    summarizedTurns: turns.slice(compactionStartIndex, compactionEndIndex),
    preservedTurns: turns.slice(compactionEndIndex),
    baseRow,
  };
}

/**
 * Headers of the payloads THIS PLUGIN injects via UserPromptSubmit.
 *
 * Claude Code writes injected additionalContext into the transcript as a
 * durable row (`type:"attachment"`, `attachment.type:"hook_additional_context"`),
 * so a turn carrying one of these IS a compaction orchestration turn, by
 * construction. That is a stronger signal than the scaffold marker, which
 * depends on the model remembering to write it — and unmarked orchestration turns
 * do occur in the field.
 *
 * Matched as a prefix on the exact headers, NOT on "[riverbed". A sibling hook
 * (the resident-context watch) injects 66 rows opening "[riverbed] This
 * session's resident conte…" on ORDINARY turns; treating those as scaffolding
 * would stub real conversation. Measured: 52 + 14 compaction payload rows
 * against 7,156 other injected-context rows, none of which collide.
 */
const ORCHESTRATION_PAYLOAD_HEADERS = [
  "[riverbed-compact]",
  "[riverbed-compact --eras]",
];

function isOrchestrationPayloadRow(row: TranscriptRow): boolean {
  const attachment = row["attachment"];
  if (!isRecord(attachment)
      || attachment["type"] !== "hook_additional_context") {
    return false;
  }
  const content = attachment["content"];
  const text = Array.isArray(content) ? content.join(" ") : String(content ?? "");
  return ORCHESTRATION_PAYLOAD_HEADERS.some(h => text.startsWith(h));
}

export function isScaffoldTurn(turn: Turn): boolean {
  // A turn holding this plugin's own injected instructions is machinery
  // whether or not it was marked. This also covers the handoff turn, which
  // the authoring payload used to forbid marking — leaving the single turn
  // that holds the dispatch, the merge call and its output as the one turn
  // guaranteed to survive. The successor still learns it was compacted: the
  // boundary row carries the post-compaction notice, which is the dedicated
  // mechanism for that and does not depend on this turn surviving.
  if (turn.rows.some(isOrchestrationPayloadRow)) {
    return true;
  }
  return turn.rows.some(row => {
    if (row.type !== "assistant" || !isRecord(row.message)) {
      return false;
    }

    const content = row.message["content"];
    if (typeof content === "string") {
      return content.includes(SCAFFOLD_MARKER);
    }

    if (!Array.isArray(content)) {
      return false;
    }

    // Any block, not just `text`. Scanning only text blocks meant a marker
    // inside a thinking block, a tool_use input, or a tool_result was
    // invisible — and the compaction's own dispatch turn puts it exactly there,
    // in the Agent/Bash call that carries the directive. A turn that says the
    // word anywhere is claiming to be scaffolding; take it at its word.
    return content.some(block => isRecord(block) && blockMentionsMarker(block));
  });
}

function blockMentionsMarker(block: JsonRecord): boolean {
  for (const value of Object.values(block)) {
    if (typeof value === "string" && value.includes(SCAFFOLD_MARKER)) {
      return true;
    }
    if (isRecord(value) && blockMentionsMarker(value)) {
      return true;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.includes(SCAFFOLD_MARKER)) {
          return true;
        }
        if (isRecord(item) && blockMentionsMarker(item)) {
          return true;
        }
      }
    }
  }
  return false;
}

export async function buildCompactedRows(
  plan: Plan,
  summaries: string[],
  sessionId: string,
  eraWork: EraWork | null = null,
): Promise<TranscriptRow[]> {
  const rows: TranscriptRow[] = [];
  const copiedUuids = new Map<string, string>();
  // The inherited era is prefix + summarized. Prefix turns are the output of
  // PRIOR compactions, and in a long-lived lineage they are the overwhelming
  // majority: measured 2026-08-10, 477 of 528 turns, carrying ~229k tokens of
  // tool I/O that copyTurnRows had been reproducing byte-faithful forever.
  // Their tool_use ids must be in scope here or the deep tier cannot name the
  // tools or tell a completed call from an in-flight one.
  const inheritedTurns = [...plan.prefixTurns, ...plan.summarizedTurns];
  const completedToolUseIds = collectCompletedToolUseIds(inheritedTurns);
  const toolNamesById = collectToolNamesById(inheritedTurns);
  const omissionCache = await loadOmissionCache(sessionId);
  const timestamp = new Date().toISOString();
  const lastOriginalRow = sourceTurns(plan)
    .flatMap(turn => turn.rows)
    .at(-1);
  if (!lastOriginalRow) {
    throw new Error("Compaction plan has no source rows.");
  }

  const boundaryUuid = randomUUID();
  rows.push({
    ...copySessionFields(plan.baseRow, sessionId, timestamp),
    type: "user",
    uuid: boundaryUuid,
    parentUuid: null,
    isMeta: true,
    message: {
      id: `msg_${randomUUID()}`,
      role: "user",
      content: POST_COMPACTION_NOTICE,
    },
    logicalParentUuid: lastOriginalRow.uuid,
    // Dual-stamped. `magicCompact` is what the upstream plugin reads, so a
    // session compacted here stays recompactable by it; `riverbedCompact` is
    // ours and is what we would keep if upstream ever moves off that field
    // (their own 2026-08 spec already describes a native boundary row).
    magicCompact: {
      boundary: true,
    },
    riverbedCompact: {
      boundary: true,
    },
  });
  let parentUuid: string | null = boundaryUuid;
  const deepPrune: PruneContext = {
    cache: omissionCache,
    sessionId,
    completedToolUseIds,
    toolNamesById,
    deep: true,
  };

  // The refined invariant. Prefix TEXT rows stay byte-faithful forever —
  // summaries, pinned verbatims, user words: the curated layer, and the whole
  // point of the riverbed. Prefix TOOL rows get the deep tier, reusing the
  // Content IDs prior compactions already minted. pruneTranscriptRow only ever
  // reaches into tool_use inputs and tool_result contents, so passing whole
  // rows through it is safe for the text; keepOnlyToolBlocks is deliberately
  // NOT applied here, unlike the summarized path where a summary has taken
  // over the narrative.
  if (eraWork === null) {
    for (const turn of plan.prefixTurns) {
      parentUuid = copyTurnRows(
        turn,
        rows,
        copiedUuids,
        sessionId,
        timestamp,
        parentUuid,
        deepPrune,
      );
    }
  } else {
    // Era-collapse. Candidate eras: user rows ride whole (v1 ruling — the
    // human's words are never touched; the wider question is left open),
    // full original rows go to the omission cache under one era Content ID,
    // one live-authored diagnostic stub replaces everything else. None of the
    // emitted rows are registered in copiedUuids: any later row that named a
    // dropped row as parent must MISS the lookup and fall through to the
    // running parentUuid — registering would recreate the double-copy branch
    // (the double-copy regression). Non-candidate eras copy exactly as before.
    for (const era of eraWork.eras) {
      if (!eraWork.candidateKeys.has(era.key)) {
        for (const turn of era.turns) {
          parentUuid = copyTurnRows(
            turn,
            rows,
            copiedUuids,
            sessionId,
            timestamp,
            parentUuid,
            deepPrune,
          );
        }
        continue;
      }
      const contentId = allocateEra(omissionCache, sessionId, era);
      for (const turn of era.turns) {
        // Same orthogonality as the summarized path: a scaffold turn inside a
        // collapsing era must not have its compaction-time attachments ride
        // whole. This path is where a leak stops being recoverable — an era
        // stub is the last form the material takes, so anything that survives
        // here survives every later generation.
        const eraScaffold = isScaffoldTurn(turn);
        for (const row of turn.rows) {
          if (
            turn.userRows.includes(row)
            || (!eraScaffold && isHumanWordsAttachmentRow(row))
            || isEraStubRow(row)
          ) {
            const copied = copyRow(row, sessionId, timestamp, parentUuid);
            rows.push(copied);
            parentUuid = copied.uuid;
          }
        }
      }
      const stub = createEraStubRow(
        era,
        eraWork.texts[era.key]!,
        contentId,
        sessionId,
        timestamp,
        parentUuid,
        plan.baseRow,
      );
      rows.push(stub);
      parentUuid = stub.uuid;
    }
  }

  let summaryIndex = 0;
  for (const turn of plan.summarizedTurns) {
    // Copies emitted for this turn BEFORE its summary row (user rows). A tool
    // row's parent lookup must never resolve to one of these: firstAssistant
    // is emitted twice (summary row + tool copy), and when nothing sits
    // between the user row and firstAssistant in the source — erosion's doing,
    // or any dropped row — the lookup HITS the user row and the tool copy
    // becomes its second child. Two children, one parent, branch: measured
    // 61-81 rows unreachable, 6 turns lost per pass on an eroded session.
    // The intervening chatter attachment was accidental padding masking
    // this, never a guarantee.
    const preSummaryCopies = new Set<string>();
    // userRows PLUS the attachment rows carrying words the human typed.
    // Queued prompts reach the transcript ONLY as `queued_command` attachments
    // with origin.kind === "human"; they have no `message`, so the isToolRow
    // filter below never copied them and every compaction destroyed them.
    // Measured on a 12.7MB fixture (2026-08-23, keep=12, no flags): 11 queued
    // human prompts in, 0 out — short mid-turn asides, several of them the
    // corrections that redirected the work. The summaries paraphrased them;
    // the originals died.
    // This is the "user words are never touched" invariant, so it is NOT
    // gated behind any flag. Found while building the erosion tier.
    //
    // The copy is deliberately NOT registered in copiedUuids: a later tool row
    // whose parentUuid names this attachment must keep MISSING the lookup and
    // fall back to the summary row. Registering it would let two rows claim the
    // same parent and branch the chain (the double-copy hazard in the loop
    // below, which erosion exposed by deleting the padding attachments).
    // Scaffoldness is orthogonal to REGION, and reading it region-wise was a
    // real leak. A scaffold turn is not always a preserved turn: an abandoned
    // or interrupted compaction run that later work buried, or an explicit
    // `/riverbed-compact 0`, puts it in the SUMMARIZED region — and this loop
    // used to run to completion before the isScaffoldTurn check below, so the
    // attachment branch copied compaction-time input and the stub was emitted
    // right after it. Reproduced on real transcripts at keep=0, carrying
    // exactly the dead imperatives the rule exists to drop.
    const scaffold = isScaffoldTurn(turn);
    for (const row of turn.rows) {
      if (turn.userRows.includes(row)) {
        const copied = copyRow(row, sessionId, timestamp, parentUuid);
        copiedUuids.set(row.uuid, copied.uuid);
        preSummaryCopies.add(copied.uuid);
        rows.push(copied);
        parentUuid = copied.uuid;
      } else if (!scaffold && isHumanWordsAttachmentRow(row)) {
        const copied = copyRow(row, sessionId, timestamp, parentUuid);
        rows.push(copied);
        parentUuid = copied.uuid;
      }
    }

    if (scaffold) {
      parentUuid = appendScaffoldStub(
        turn,
        rows,
        copiedUuids,
        sessionId,
        timestamp,
        parentUuid,
      );
      continue;
    }

    const firstAssistant = turn.rows.find(row => row.type === "assistant");
    if (!firstAssistant) {
      throw new Error("Turn missing assistant row for summary shape.");
    }

    const summary = summaries[summaryIndex];
    summaryIndex += 1;
    if (summary === undefined) {
      throw new Error("Missing summary for compacted turn.");
    }

    const copied = createAssistantSummaryRow(
      firstAssistant,
      sessionId,
      timestamp,
      parentUuid,
      summary,
    );
    copiedUuids.set(firstAssistant.uuid, copied.uuid);
    rows.push(copied);
    parentUuid = copied.uuid;

    for (const row of turn.rows) {
      if (turn.userRows.includes(row) || !isToolRow(row)) {
        continue;
      }

      const resolvedParent = row.parentUuid
        ? copiedUuids.get(row.parentUuid)
        : undefined;
      const copiedToolRow = copyRow(
        row,
        sessionId,
        timestamp,
        resolvedParent !== undefined && !preSummaryCopies.has(resolvedParent)
          ? resolvedParent
          : parentUuid,
      );
      keepOnlyToolBlocks(copiedToolRow);
      // Summarized eras get the deep tier: their narrative lives in the
      // summary; the tool I/O is archaeology, retrievable by Content ID.
      pruneTranscriptRow(copiedToolRow, deepPrune);
      copiedUuids.set(row.uuid, copiedToolRow.uuid);
      rows.push(copiedToolRow);
      parentUuid = copiedToolRow.uuid;
    }
  }

  for (const turn of plan.preservedTurns) {
    if (isScaffoldTurn(turn)) {
      // DELIBERATE ASYMMETRY — do not "fix" this to match its siblings.
      //
      // The summarized path (above) and the era path both call
      // isHumanWordsAttachmentRow, because a queued prompt there is CONTENT:
      // something typed earlier in the conversation that the summaries would
      // otherwise paraphrase away. This branch does not, because a scaffold
      // turn IS the compaction machinery, and a queued prompt inside one was
      // typed at that machinery while it ran.
      //
      // Those are operational — "wait", "no", "stop", "not that one" — aimed
      // at a context that is being replaced. Carried forward they arrive in
      // the new session's recent history with nothing around them to date
      // them, and the successor reads a dead imperative as a live one. Input
      // typed during a compaction is discarded with the rest of the
      // scaffolding.
      //
      // This was made symmetric once, on the reasoning that the branch merely
      // looked like an oversight. It is not. See tests/queued-prompts.test.ts.
      for (const row of turn.userRows) {
        const copied = copyRow(row, sessionId, timestamp, parentUuid);
        copiedUuids.set(row.uuid, copied.uuid);
        rows.push(copied);
        parentUuid = copied.uuid;
      }
      parentUuid = appendScaffoldStub(
        turn,
        rows,
        copiedUuids,
        sessionId,
        timestamp,
        parentUuid,
      );
      continue;
    }

    parentUuid = copyTurnRows(
      turn,
      rows,
      copiedUuids,
      sessionId,
      timestamp,
      parentUuid,
    );
  }

  await saveOmissionCache(sessionId, omissionCache);
  return rows;
}

function appendScaffoldStub(
  turn: Turn,
  rows: TranscriptRow[],
  copiedUuids: Map<string, string>,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
): string {
  const firstAssistant = turn.rows.find(row => row.type === "assistant");
  if (!firstAssistant) {
    throw new Error("Scaffold turn missing assistant row.");
  }

  const stub = createScaffoldStubRow(
    firstAssistant,
    sessionId,
    timestamp,
    parentUuid,
  );
  copiedUuids.set(firstAssistant.uuid, stub.uuid);
  rows.push(stub);
  return stub.uuid;
}

/** Copies a turn verbatim. With `prune` supplied the copy's tool I/O is pruned
 * in place and its text left alone; without it — the preserved keep-N region —
 * nothing is touched at all. */
function copyTurnRows(
  turn: Turn,
  rows: TranscriptRow[],
  copiedUuids: Map<string, string>,
  sessionId: string,
  timestamp: string,
  initialParentUuid: string | null,
  prune?: PruneContext,
): string | null {
  let parentUuid = initialParentUuid;
  for (const row of turn.rows) {
    const copied = copyRow(
      row,
      sessionId,
      timestamp,
      row.parentUuid
        ? (copiedUuids.get(row.parentUuid) ?? parentUuid)
        : parentUuid,
    );
    if (prune) {
      pruneTranscriptRow(copied, prune);
    }
    copiedUuids.set(row.uuid, copied.uuid);
    rows.push(copied);
    parentUuid = copied.uuid;
  }
  return parentUuid;
}

function copyRow(
  row: TranscriptRow,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
): TranscriptRow {
  const copied = structuredClone(row) as TranscriptRow;
  // Carry origin identity forward BEFORE re-minting uuid. Without this the
  // join key dies with the copy: summaries authored against a turn become
  // unlinkable the moment that turn is compacted, which is exactly when the
  // summary starts mattering. Set once, never overwritten.
  copied.originUuid = originKey(row);
  copied.uuid = randomUUID();
  copied.parentUuid = parentUuid;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  return copied;
}

function collectCompletedToolUseIds(turns: Turn[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      if (!isRecord(row.message)) {
        continue;
      }
      const content = row.message["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (
          isRecord(block)
          && block["type"] === "tool_result"
          && block["is_error"] !== true
          && typeof block["tool_use_id"] === "string"
        ) {
          ids.add(block["tool_use_id"]);
        }
      }
    }
  }
  return ids;
}

function collectToolNamesById(turns: Turn[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const turn of turns) {
    for (const row of turn.rows) {
      if (!isRecord(row.message)) {
        continue;
      }
      const content = row.message["content"];
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (
          isRecord(block)
          && block["type"] === "tool_use"
          && typeof block["id"] === "string"
          && typeof block["name"] === "string"
        ) {
          names.set(block["id"], block["name"]);
        }
      }
    }
  }
  return names;
}

function isToolRow(row: TranscriptRow): boolean {
  if (!isRecord(row.message)) {
    return false;
  }

  const content = row.message["content"];
  return (
    Array.isArray(content)
    && content.some(
      block =>
        isRecord(block)
        && (block["type"] === "tool_use" || block["type"] === "tool_result"),
    )
  );
}

function keepOnlyToolBlocks(row: TranscriptRow): void {
  if (!isRecord(row.message)) {
    return;
  }

  const content = row.message["content"];
  if (!Array.isArray(content)) {
    return;
  }

  row.message["content"] = content.filter(
    block =>
      isRecord(block)
      && (block["type"] === "tool_use" || block["type"] === "tool_result"),
  );
}

// Summary markers stay on the upstream `magicCompact` field for
// interoperability; see the note in transcript.ts.
// Either marker counts. We WRITE both; upstream writes only `magicCompact`;
// rows compacted before the dual-stamp carry only `magicCompact` too.
// NB: this is our own marker, NOT Claude Code's native `isCompactSummary`
// field — see isHumanUserRow in transcript.ts.
function isCompactSummaryRow(row: TranscriptRow): boolean {
  for (const field of ["riverbedCompact", "magicCompact"]) {
    const marker = row[field];
    if (isRecord(marker) && marker["summary"] === true) {
      return true;
    }
  }
  return false;
}

function sourceTurns(plan: Plan): Turn[] {
  return [...plan.prefixTurns, ...plan.summarizedTurns, ...plan.preservedTurns];
}

function createAssistantSummaryRow(
  source: TranscriptRow,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
  summary: string,
): TranscriptRow {
  const copied = structuredClone(source) as TranscriptRow;
  copied.uuid = randomUUID();
  copied.parentUuid = parentUuid;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  copied.message = {
    ...source.message,
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "text", text: summary }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };
  copied["magicCompact"] = { summary: true };
  // Generation tag: which compaction pass authored this summary. Summary-run
  // adjacency erases generation identity (one summaries pass after an era
  // pass fused a live bed into one immune 507-turn era, 2026-08-27); the tag
  // survives byte-faithful copying forever, so eras stay separable no matter
  // how the runs merge. sessionId of the DESTINATION is unique per pass.
  //
  // `summary: true` rides alongside it rather than replacing it — the marker
  // and the generation tag are different facts about the same row, and an
  // earlier port of the dual-stamp that overwrote one with the other is
  // exactly how the two repos silently diverged.
  copied["riverbedCompact"] = { summary: true, gen: sessionId };
  return copied;
}

// Scaffold stubs are deliberately NOT marked as summary rows: a summary
// marker moves the recompaction boundary, and a stub emitted inside the
// preserved range would then permanently exempt earlier preserved turns from
// future summarization. An unmarked one-line stub simply gets re-summarized
// (trivially) on the next compaction, which is correct.
function createScaffoldStubRow(
  source: TranscriptRow,
  sessionId: string,
  timestamp: string,
  parentUuid: string | null,
): TranscriptRow {
  const copied = structuredClone(source) as TranscriptRow;
  copied.uuid = randomUUID();
  copied.parentUuid = parentUuid;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  copied.message = {
    ...source.message,
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [{ type: "text", text: SCAFFOLD_STUB_TEXT }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };
  delete copied["magicCompact"];
  copied["riverbedCompact"] = { scaffold: true };
  return copied;
}

function copySessionFields(
  row: TranscriptRow,
  sessionId: string,
  timestamp: string,
): TranscriptRow {
  const copied = structuredClone(row) as TranscriptRow;
  copied.sessionId = sessionId;
  copied.timestamp = timestamp;
  copied.isSidechain = false;
  delete copied.message;
  return copied;
}

/**
 * An attachment row carrying words the human typed. Queued prompts arrive as
 * `queued_command` attachments with origin.kind === "human" and are never
 * duplicated as user rows, so nothing else in this file preserves them.
 */
function isHumanWordsAttachmentRow(row: TranscriptRow): boolean {
  const attachment = row["attachment"];
  if (!isRecord(attachment) || attachment["type"] !== "queued_command") {
    return false;
  }
  const origin = attachment["origin"];
  return isRecord(origin) && origin["kind"] === "human";
}
