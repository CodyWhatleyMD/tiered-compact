/**
 * Orchestration payloads for the self-guiding /riverbed-compact command.
 *
 * The hook cannot write summaries (inline mode needs the live context) and
 * cannot dispatch forks (only the live instance can call
 * Agent(subagent_type: "fork")). So when no summaries file exists yet,
 * `/riverbed-compact N [--fork [K]]` does not compact: the hook computes the
 * plan and injects one of these payloads into the live instance's context via
 * UserPromptSubmit additionalContext.
 *
 *   inline (default): the live instance writes riverbed-summaries.part-1.json
 *   itself (mode B authorship).
 *   fork (--fork [K]): the live instance dispatches one fork per partition;
 *   each fork inherits the live conversation and writes its own part file.
 *
 * Both modes then run merge.ts, which validates coverage against the
 * boundary anchor (uuid of the first preserved turn at plan time — immune to
 * the turn-count drift caused by orchestration turns), writes
 * riverbed-summaries.json, and prints the recommended N. The user re-runs
 * plain /riverbed-compact <recommendedN>, which now finds the file and
 * assembles the compacted session.
 */
import { dirname, join } from "node:path";
import { createPlan, isScaffoldTurn } from "./compact";
import { transcriptId, turnKey } from "./summaries";
import {
  isRecord,
  readActiveTranscriptRows,
  type Turn,
} from "./transcript";

export const MAX_FORKS = 16;

export type OrchestrationMode =
  | { type: "inline" }
  | { type: "fork"; count: number | null }
  | { type: "subagent"; count: number | null; model: string | null };

type PlannedTurn = {
  seq: number;
  key: string;
  rows: number;
  user: string;
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

  const planned: PlannedTurn[] = toSummarize.map((turn, index) => ({
    seq: index,
    key: turnKey(turn),
    rows: turn.rows.length,
    user: turnUserPreview(turn),
  }));
  const boundaryTurn = plan.preservedTurns[0] ?? null;
  const boundaryKey = boundaryTurn === null ? "END" : turnKey(boundaryTurn);
  const directory = dirname(transcriptPath);
  const mergeScript = join(import.meta.dir, "merge.ts");
  const mergeCommand = `bun ${mergeScript} ${transcriptPath} ${boundaryKey}`;

  const shared = {
    header:
      "[riverbed-compact] No summaries file exists yet, so nothing was compacted. YOU (the live instance) author the summaries now, then the user re-runs the command to assemble.",
    plan: `plan: keepTurns=${keepTurns ?? "(none — eras only)"}, turnsNeedingSummaries=${planned.length}, boundaryKey=${boundaryKey}`,
    style: [
      "Summary style: <=200 words per turn (more only when genuinely warranted),",
      "written to replace the assistant turn in the conversation's natural flow —",
      "no meta-commentary.",
      "",
      "What survives without you, and what does not:",
      "  - the tool CALL survives (command, file path, arguments) — don't restate it;",
      "  - the tool RESULT does NOT. Every result over 200 characters becomes a",
      "    retrievable stub, and assistant prose and thinking are dropped entirely.",
      "    So the READING of a result — what the grep proved, which number was",
      "    wrong, which hypothesis it killed, which file holds the thing — survives",
      "    nowhere but your summary. Write it down.",
      "",
      "Curate by tier: embed pinned verbatims EXACTLY inside the relevant summaries;",
      "keep load-bearing threads' mechanisms intact; one line for prune-hard turns;",
      "deep history compresses hard, recent arcs keep texture. Prune superseded",
      "debugging — but keep the bug and its fix: a dead path is prunable, a fixed",
      "defect is live state of the code.",
      "",
      "Consecutive human messages with no reply between them are ONE turn. If a",
      "turn's preview shows several, write a single summary covering all of them.",
    ].join("\n"),
    fileContract: (name: string) =>
      `Write ${directory}/${name} containing {"transcript": "${transcriptId(transcriptPath)}", "summaries": {"<turn key>": "<summary text>", ...}}. The "transcript" stamp is what stops another session in this project from consuming your summaries — include it verbatim.`,
    finish: `Then: ${mergeCommand} — it validates coverage against the boundary anchor, writes riverbed-summaries.json, and prints the recommended N. Run the merge in your FINAL turn: that same turn IS the handoff (turns only advance on user input, so a separate post-merge turn cannot exist). Give it standing state (running/scheduled/pending) and hand the user the exact command merge.ts printed: /riverbed-compact <recommendedN> (plain, no --fork), to run before anything else. Never run it yourself. Every turn you spent orchestrating (dispatching, waiting, deliberating, and the final merge/handoff turn itself) should carry the literal token [[riverbed:scaffold]] in its text. The handoff is spent BEFORE the crossing — the user reads it in this session, which is never modified — so it is stubbed in the compacted one, and the successor learns it was compacted from the post-compaction notice instead. Turns carrying this payload are detected as orchestration regardless, so a forgotten marker is not a leak; the token is still worth writing because it is what a human reading the transcript sees. After merging, sanity-check N: (totalTurns - boundaryIndex) via buildAssistantTurns must equal the printed N once your final turn's rows are flushed. Before handing off: if this project keeps durable notes, write down anything not yet recorded — it is cheaper to write it now, at full detail, than to reconstruct it from a summary later.`,
  };

  if (mode.type === "inline") {
    return [
      shared.header,
      "",
      `${shared.plan}, mode=inline`,
      "",
      `1. ${shared.style}`,
      `2. ${shared.fileContract("riverbed-summaries.part-1.json")} Cover EVERY key listed below. For turns you cannot see in your context (e.g. sibling attachments), read their rows from ${transcriptPath} first.`,
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
      ? `2. Dispatch one fork per partition via Agent(subagent_type: "fork"). Each fork inherits this conversation. Its directive: summarize EXACTLY its assigned turns (keys + previews below). ${shared.style} For turns not visible in inherited context (sibling attachments), read those rows from ${transcriptPath}. ${shared.fileContract("riverbed-summaries.part-<i>.json")} Report the path + key count, then stop. Include the curation directive (pinned verbatims etc.) verbatim in every fork's prompt — forks cannot see each other.`
      : `2. Dispatch one general-purpose subagent per partition via the Agent tool${
          mode.model === null ? "" : ` with model: "${mode.model}"`
        }. Subagents inherit NO context — each directive must be self-contained: first run \`bun ${sliceScript} ${transcriptPath} <its turn keys>\` to read its assigned turns, then summarize them. ${shared.style} ${shared.fileContract("riverbed-summaries.part-<i>.json")} Report the path + key count. Include the curation directive (pinned verbatims etc.) verbatim in every subagent's prompt — they see nothing but what you hand them, so spell out anything a summary must preserve.`;
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
      ? "Costs: each fork re-reads the parent's full live context (cache-read pricing). Do not exceed the requested/chosen fork count. GATE: if the Agent tool rejects subagent_type \"fork\" (type not found), fork subagents are not enabled on this install — tell the user to either add CLAUDE_CODE_FORK_SUBAGENT=1 to the env block of ~/.claude/settings.json (takes effect after a settings/plugin reload) or re-run as /riverbed-compact N --subagent [K]; do not improvise a different worker type unprompted."
      : "Fidelity note: subagents see only their slice (plus your directive), not the conversation — cheaper than forks, but curate the directive carefully.",
    "",
    partitions === null
      ? `turns (partition these yourself): ${JSON.stringify(planned)}`
      : `partitions: ${JSON.stringify(
          partitions.map((part, index) => ({
            fork: index + 1,
            file: `riverbed-summaries.part-${index + 1}.json`,
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
