/**
 * Plan inspector for mode B (live-session summarizer).
 *
 *   bun src/plan.ts <transcriptPath> <keepN>
 *
 * Prints, as JSON, the turns /riverbed-compact would summarize at keepN —
 * keyed exactly as the summaries file expects — so the live in-context
 * instance can write riverbed-summaries.json next to the transcript and the
 * hook can compact without ever spawning a headless resume.
 *
 * Read-only: touches nothing, writes nothing.
 */
import { createPlan, isScaffoldTurn } from "./compact";
import { loadSummariesFile, resolveTurnSummary, turnKey } from "./summaries";
import { isRecord, readActiveTranscriptRows } from "./transcript";

function preview(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const firstLine = value.split("\n", 1)[0] ?? "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}

function turnUserPreview(rows: { message?: Record<string, unknown> }[]): string {
  for (const row of rows) {
    const content = row.message?.["content"];
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
  }
  return "";
}

async function main(): Promise<void> {
  const [transcriptPath, keepRaw] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error("Usage: bun src/plan.ts <transcriptPath> <keepN>");
    process.exit(2);
  }
  const keepTurns = keepRaw === undefined ? 0 : Number(keepRaw);
  if (!Number.isInteger(keepTurns) || keepTurns < 0) {
    console.error("keepN must be a non-negative integer.");
    process.exit(2);
  }

  const rows = await readActiveTranscriptRows(transcriptPath);
  const plan = createPlan(rows, keepTurns);
  const summarize = plan.summarizedTurns.filter(turn => !isScaffoldTurn(turn));

  // Coverage report: when a summaries file already exists, show per-turn
  // coverage and the exact command whose boundary matches the file — no
  // hand arithmetic (which failed 2026-07-22: "76−61=15" was confidently
  // wrong because the keys, not the counts, were off).
  let coverage: Record<string, unknown> | undefined;
  let file = null;
  let fileError: string | undefined;
  try {
    file = await loadSummariesFile(transcriptPath);
  } catch (error) {
    fileError = error instanceof Error ? error.message : String(error);
  }
  if (file !== null) {
    const covered = summarize.map(turn => resolveTurnSummary(file, turn) !== null);
    const firstGap = covered.indexOf(false);
    const uncoveredTail =
      firstGap === -1 ? 0 : covered.length - firstGap;
    const interiorGaps =
      firstGap === -1 ? false : covered.slice(firstGap).includes(true);
    coverage = {
      fileTurnsCovered: covered.filter(Boolean).length,
      needingSummaries: covered.length,
      uncoveredTail,
      interiorGaps,
      note: interiorGaps
        ? "interior gaps: fill the missing keys (listed under turns[].covered=false) — the merge hard-fails on these"
        : uncoveredTail > 0
          ? `uncovered tail of ${uncoveredTail} turn(s) will ride whole automatically (drift tolerance) — or run /riverbed-compact ${keepTurns + uncoveredTail} to match the file exactly`
          : "file fully covers the plan — run /riverbed-compact "
            + String(keepTurns),
    };
  } else if (fileError !== undefined) {
    coverage = { fileError };
  }

  console.log(
    JSON.stringify(
      {
        keepTurns,
        totals: {
          prefix: plan.prefixTurns.length,
          summarized: plan.summarizedTurns.length,
          scaffolds: plan.summarizedTurns.length - summarize.length,
          needingSummaries: summarize.length,
          preserved: plan.preservedTurns.length,
        },
        ...(coverage !== undefined ? { coverage } : {}),
        turns: summarize.map((turn, index) => ({
          seq: index,
          key: turnKey(turn),
          rows: turn.rows.length,
          user: turnUserPreview(turn.userRows),
          ...(file !== null
            ? { covered: resolveTurnSummary(file, turn) !== null }
            : {}),
        })),
      },
      null,
      2,
    ),
  );
}

await main();
