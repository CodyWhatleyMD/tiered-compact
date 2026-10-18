/**
 * Orchestration payloads for the self-guiding /tiered-compact command.
 *
 * The hook cannot write summaries (inline mode needs the live context) and
 * cannot dispatch forks (only the live instance can call
 * Agent(subagent_type: "fork")). So when no summaries file exists yet,
 * `/tiered-compact N [--fork [K]]` does not compact: the hook computes the
 * plan and injects one of these payloads into the live instance's context via
 * UserPromptSubmit additionalContext.
 *
 *   inline (default): the live instance writes tiered-summaries.part-1.json
 *   itself (mode B authorship).
 *   fork (--fork [K]): the live instance dispatches one fork per partition;
 *   each fork inherits the live conversation and writes its own part file.
 *
 * Both modes then run merge.ts, which validates coverage against the
 * boundary anchor (uuid of the first preserved turn at plan time — immune to
 * the turn-count drift caused by orchestration turns), writes
 * tiered-summaries.json, and prints the recommended N. The user re-runs
 * plain /tiered-compact <recommendedN>, which now finds the file and
 * assembles the compacted session.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPlan, isScaffoldTurn, SCAFFOLD_MARKER } from "./compact";
import { transcriptId, turnKey } from "./summaries";
import {
  isRecord,
  originKey,
  readActiveTranscriptRows,
  type Turn,
} from "./transcript";

export const MAX_FORKS = 16;

/**
 * Drafts a companion mod wrote for this session as it ran, keyed by a row id
 * of each turn (the turn's first human row, as it was live; copies keep that id
 * as originUuid). Null when no drafts file exists or its file can't be
 * read: the payload then reads exactly as before.
 */
export async function draftsFile(
  transcriptPath: string,
): Promise<{ path: string; keys: Set<string> } | null> {
  const dir = process.env["TIERED_COMPACT_DRAFTS_DIR"]
    ?? join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "tiered-drafts");
  const path = join(dir, `${transcriptId(transcriptPath)}.json`);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const parsed: unknown = JSON.parse(await file.text());
    if (!isRecord(parsed) || !isRecord(parsed["summaries"])) return null;
    return { path, keys: new Set(Object.keys(parsed["summaries"])) };
  } catch {
    return null;
  }
}

export type OrchestrationMode =
  | { type: "inline" }
  | { type: "fork"; count: number | null }
  | { type: "subagent"; count: number | null; model: string | null };

type PlannedTurn = {
  seq: number;
  key: string;
  rows: number;
  user: string;
  drafted?: true; // a drafts file already covers it
};

export async function buildOrchestrationPayload(
  transcriptPath: string,
  keepTurns: number | null,
  mode: OrchestrationMode,
): Promise<string | null> {
  const rows = await readActiveTranscriptRows(transcriptPath);
  const plan = createPlan(rows, keepTurns);
  const toSummarize = plan.summarizedTurns.filter(
    turn => !isScaffoldTurn(turn),
  );
  if (toSummarize.length === 0) {
    return null; // nothing to summarize — caller falls through to normal path
  }

  const drafts = await draftsFile(transcriptPath);
  const planned: PlannedTurn[] = toSummarize.map((turn, index) => ({
    seq: index,
    key: turnKey(turn),
    rows: turn.rows.length,
    user: turnUserPreview(turn),
    ...(drafts !== null && turn.rows.some(row => drafts.keys.has(originKey(row)))
      ? { drafted: true as const }
      : {}),
  }));
  const draftedCount = planned.filter(turn => turn.drafted).length;
  const draftsNote = drafts === null || draftedCount === 0
    ? ""
    : `A drafts file written as the session ran already covers ${draftedCount} of these ${planned.length} turns ("drafted": true in the list): ${drafts.path}, under "summaries", keyed by a row id of each turn. They were written a few turns after each happened, without hindsight. For each, keep it as written, revise it, or replace it with what you know now; that's usually quicker than writing from scratch, and no worse. Turns it didn't draft need fresh summaries.`;
  const boundaryTurn = plan.preservedTurns[0] ?? null;
  const boundaryKey = boundaryTurn === null ? "END" : turnKey(boundaryTurn);
  const directory = dirname(transcriptPath);
  const mergeScript = join(import.meta.dir, "merge.ts");
  const mergeCommand = `bun ${mergeScript} ${transcriptPath} ${boundaryKey}`;

  const shared = {
    header:
      `[tiered-compact] No summaries file exists yet, so nothing was compacted. The summaries are yours to write: you're the session that still has the material. Three steps: (1) write the summaries file described below; (2) in your final turn run \`${mergeCommand}\`, which writes tiered-summaries.json, the file the crossing actually reads; (3) hand the person the command it prints. The turn list is at the end.${draftedCount > 0 ? ` A drafts file already covers ${draftedCount} of the ${planned.length} turns; see below.` : ""}`,
    plan: `plan: keepTurns=${keepTurns ?? "(none — eras only)"}, turnsNeedingSummaries=${planned.length}, boundaryKey=${boundaryKey}`,
    style: [
      "Summary style: up to about 200 words a turn (more when a turn genuinely needs it),",
      "written to stand in for the assistant's turn in the conversation's flow,",
      "without meta-commentary.",
      "",
      "What survives without you, and what doesn't:",
      "  - the tool CALL survives (command, file path, arguments), so there's no need to restate it;",
      "  - the tool RESULT doesn't. Every result over 200 characters becomes a",
      "    retrievable stub, and assistant prose and thinking are dropped. So the",
      "    reading of a result (what the grep proved, which number was wrong, which",
      "    hypothesis it killed, which file holds the thing) survives only in your summary.",
      "",
      "Curating is your judgment. Some leanings, with their reasons:",
      "  - The person's own rows ride whole, so their words don't need restating. Quote",
      "    exact wording only where the wording itself matters (a decision's terms, a",
      "    name, a number); paraphrase otherwise.",
      "  - Some text in the person's channel isn't theirs: a side agent's note they",
      "    forwarded, a slash command's output, a harness notice. When a summary",
      "    mentions it, credit its source rather than the person.",
      "  - Earlier turns' thinking may be in your context. Whether any of it belongs in a",
      "    summary is your call: a clause can carry a reason or a ruled-out path that the",
      "    outcome doesn't show. It's a summarized rendering of the reasoning, so lean on",
      "    what the outcome bears out.",
      "  - Deep history can compress hard; recent arcs keep texture. A dead debugging",
      "    path can go, but a fixed bug and its fix are live state of the code.",
      "",
      "Consecutive human messages with no reply between them are one turn; if a",
      "preview shows several, one summary covers them all.",
    ].join("\n"),
    fileContract: (name: string) =>
      `Write ${directory}/${name} containing {"transcript": "${transcriptId(transcriptPath)}", "summaries": {"<turn key>": "<summary text>", ...}}. The "transcript" stamp keeps another session in this project from consuming your summaries; copy it as given.`,
    finish: `Then run the merge: ${mergeCommand}. It checks coverage against the boundary anchor, writes tiered-summaries.json (without it, a re-run reports "No summaries file exists yet"), and prints the recommended N. Run it in your final turn: that turn is the handoff, since turns only advance on the person's input. Tell the person the state of anything running or scheduled, and give them the exact command merge.ts printed (/tiered-compact <recommendedN>, plain, no --fork) to run before anything else; running it is theirs, not yours. The turns spent on this are machinery and get stubbed at the crossing. Tiered Compact recognizes them from this payload, so writing ${SCAFFOLD_MARKER} in them is optional, a courtesy to a human reading the raw transcript; the successor learns it was compacted from the post-compaction notice. To sanity-check N: (totalTurns - boundaryIndex) via buildAssistantTurns should match it once your final turn's rows are flushed. And before handing off, anything this project should remember that isn't written down yet is cheaper to write now, at full detail, than to reconstruct from a summary later.`,
  };

  if (mode.type === "inline") {
    return [
      shared.header,
      "",
      `${shared.plan}, mode=inline`,
      "",
      `1. ${shared.style}${draftsNote ? `\n\n${draftsNote}` : ""}`,
      `2. ${shared.fileContract("tiered-summaries.part-1.json")} Every key listed below needs a summary: a missing one stops the crossing with an error naming it. For turns you can't see in your context (e.g. sibling attachments), read their rows from ${transcriptPath} first.`,
      `3. ${shared.finish}`,
      "",
      `turns: ${JSON.stringify(planned)}`,
    ].join("\n");
  }

  const count =
    mode.count === null ? null : Math.min(mode.count, planned.length);
  const partitions =
    count === null ? null : partitionContiguous(planned, count);
  const workerNoun = mode.type === "fork" ? "fork" : "subagent";
  const sliceScript = join(import.meta.dir, "slice.ts");
  const dispatch =
    mode.type === "fork"
      ? `2. Dispatch one fork per partition via Agent(subagent_type: "fork"). Each fork inherits this conversation. Its directive: summarize EXACTLY its assigned turns (keys + previews below). ${shared.style}${draftsNote ? ` ${draftsNote}` : ""} For turns not visible in inherited context (sibling attachments), read those rows from ${transcriptPath}. ${shared.fileContract("tiered-summaries.part-<i>.json")} Report the path + key count, then stop. Include the curation guidance above in every fork's prompt, since forks can't see each other.`
      : `2. Dispatch one general-purpose subagent per partition via the Agent tool${
          mode.model === null ? "" : ` with model: "${mode.model}"`
        }. Subagents inherit NO context — each directive must be self-contained: first run \`bun ${sliceScript} ${transcriptPath} <its turn keys>\` to read its assigned turns, then summarize them. ${shared.style}${draftsNote ? ` ${draftsNote}` : ""} ${shared.fileContract("tiered-summaries.part-<i>.json")} Report the path + key count. Include the curation guidance above in every subagent's prompt: they see nothing but what you hand them, so spell out anything a summary should preserve.`;
  return [
    shared.header,
    "",
    `${shared.plan}, mode=${mode.type}, ${workerNoun}Count=${count ?? "you decide"}`,
    "",
    count === null
      ? `1. Choose the ${workerNoun} count yourself: aim for roughly 25-40 turns per ${workerNoun}, between 1 and ${MAX_FORKS}, then partition the turn list below contiguously.`
      : `1. Partitions are precomputed below — one ${workerNoun} per partition.`,
    dispatch,
    `3. When all ${workerNoun}s have reported: ${shared.finish}`,
    "",
    mode.type === "fork"
      ? "Costs: each fork re-reads the parent's full live context (cache-read pricing). Do not exceed the requested/chosen fork count. GATE: if the Agent tool rejects subagent_type \"fork\" (type not found), fork subagents are not enabled on this install — tell the user to either add CLAUDE_CODE_FORK_SUBAGENT=1 to the env block of ~/.claude/settings.json (takes effect after a settings/plugin reload) or re-run as /tiered-compact N --subagent [K]; do not improvise a different worker type unprompted."
      : "Fidelity note: subagents see only their slice (plus your directive), not the conversation — cheaper than forks, but curate the directive carefully.",
    "",
    partitions === null
      ? `turns (partition these yourself): ${JSON.stringify(planned)}`
      : `partitions: ${JSON.stringify(
          partitions.map((part, index) => ({
            fork: index + 1,
            file: `tiered-summaries.part-${index + 1}.json`,
            turns: part,
          })),
        )}`,
  ].join("\n");
}

/** Contiguous split into k parts, balanced by row weight, every part non-empty. */
export function partitionContiguous(
  turns: PlannedTurn[],
  k: number,
): PlannedTurn[][] {
  const count = Math.max(1, Math.min(k, turns.length));
  const total = turns.reduce((sum, turn) => sum + turn.rows, 0);
  const parts: PlannedTurn[][] = [];
  let current: PlannedTurn[] = [];
  let accumulated = 0;

  for (let index = 0; index < turns.length; index++) {
    current.push(turns[index]!);
    accumulated += turns[index]!.rows;
    const remainingTurns = turns.length - index - 1;
    const remainingParts = count - parts.length - 1;
    if (
      parts.length < count - 1
      && (accumulated >= (total * (parts.length + 1)) / count
        || remainingTurns === remainingParts)
    ) {
      parts.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

function rowPreview(row: Turn["userRows"][number]): string | null {
  const content = isRecord(row.message) ? row.message["content"] : undefined;
  if (typeof content === "string") {
    return preview(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block["type"] === "text") {
        return preview(block["text"]);
      }
    }
  }
  return null;
}

/**
 * Preview of the human side of a turn.
 *
 * Shows EVERY human message in the turn, not just the first. Consecutive
 * human messages with no assistant reply between them fold into one turn,
 * and 12.1% of turns in the real transcripts here are folded that way — some
 * carrying four separate messages. Previewing only the first told the author
 * a folded turn was a single exchange, so they wrote one summary for the one
 * message they could see and the rest went unmentioned into a summary that
 * never claimed to cover them.
 */
export function turnUserPreview(turn: Turn): string {
  const previews = turn.userRows
    .map(rowPreview)
    .filter((p): p is string => p !== null && p !== "");
  if (previews.length === 0) {
    return "";
  }
  if (previews.length === 1) {
    return previews[0] as string;
  }
  return `[${previews.length} messages, one turn] ${previews.join(" ⏎ ")}`;
}

function preview(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const firstLine = value.split("\n", 1)[0] ?? "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}
