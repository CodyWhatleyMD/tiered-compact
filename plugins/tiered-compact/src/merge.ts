/**
 * Merge fork partials into the mode B summaries file (mode C, step 4).
 *
 *   bun src/merge.ts <transcriptPath> <boundaryKey|END>
 *
 * Collects tiered-summaries.part-*.json next to the transcript, validates
 * that together they cover every non-scaffold turn BEFORE the boundary turn
 * (anchored by uuid, so orchestration turns appended since the plan don't
 * shift the target set), writes tiered-summaries.json, retires the partials
 * to .merged, and prints the recommended N for the final plain
 * /tiered-compact run. The recommended N counts turns from the boundary to
 * the current end PLUS ONE for the handoff turn the orchestrator writes after
 * this merge; every turn between boundary and handoff must carry the
 * [[tiered:scaffold]] marker or it will surface as a missing-summary error
 * at compaction time (by design).
 */
import { readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isScaffoldTurn } from "./compact";
import {
  SUMMARIES_FILENAME,
  summariesPath,
  transcriptId,
  turnKey,
} from "./summaries";
import {
  buildAssistantTurns,
  isRecord,
  readActiveTranscriptRows,
  type TranscriptRow,
} from "./transcript";

const PART_PREFIX = "tiered-summaries.part-";

async function main(): Promise<void> {
  const [transcriptPath, boundaryKey] = process.argv.slice(2);
  if (!transcriptPath || !boundaryKey) {
    console.error("Usage: bun src/merge.ts <transcriptPath> <boundaryKey|END>");
    process.exit(2);
  }

  const directory = dirname(transcriptPath);
  const partNames = (await readdir(directory))
    .filter(name => name.startsWith(PART_PREFIX) && name.endsWith(".json"))
    .sort();
  if (partNames.length === 0) {
    console.error(`No ${PART_PREFIX}*.json files found in ${directory}.`);
    process.exit(1);
  }

  const summaries: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const name of partNames) {
    const parsed: unknown = JSON.parse(
      await Bun.file(join(directory, name)).text(),
    );
    if (!isRecord(parsed) || !isRecord(parsed["summaries"])) {
      console.error(
        `${name} is malformed: expected {"summaries": {"<uuid>": "<text>"}}.`,
      );
      process.exit(1);
    }
    for (const [key, value] of Object.entries(parsed["summaries"])) {
      if (typeof value !== "string" || value.trim() === "") {
        console.error(`${name}: summary for ${key} must be a non-empty string.`);
        process.exit(1);
      }
      if (key in summaries && summaries[key] !== value.trim()) {
        conflicts.push(`${key} (${name})`);
      }
      summaries[key] = value.trim();
    }
  }
  if (conflicts.length > 0) {
    console.error(
      `Conflicting duplicate summaries for: ${conflicts.join(", ")}. Fix the partials and re-run.`,
    );
    process.exit(1);
  }

  const rows = await readActiveTranscriptRows(transcriptPath);
  const turns = buildAssistantTurns(rows);
  const prefixEnd =
    turns.findLastIndex(turn => turn.rows.some(isCompactSummaryRow)) + 1;
  const boundaryIndex =
    boundaryKey === "END"
      ? turns.length
      : turns.findIndex(turn => turnKey(turn) === boundaryKey);
  if (boundaryIndex === -1) {
    console.error(`Boundary key ${boundaryKey} not found in transcript turns.`);
    process.exit(1);
  }

  const needed = turns
    .slice(prefixEnd, boundaryIndex)
    .filter(turn => !isScaffoldTurn(turn))
    .map(turnKey);
  const missing = needed.filter(key => !(key in summaries));
  if (missing.length > 0) {
    console.error(
      `Partials are missing ${missing.length} turn(s): `
        + `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}. `
        + "Dispatch a fill-in fork for these keys (or write them live), then re-run merge.",
    );
    process.exit(1);
  }
  const extras = Object.keys(summaries).filter(key => !needed.includes(key));

  const output: Record<string, string> = {};
  for (const key of needed) {
    output[key] = summaries[key]!;
  }
  await Bun.write(
    summariesPath(transcriptPath),
    `${JSON.stringify(
      { transcript: transcriptId(transcriptPath), summaries: output },
      null,
      2,
    )}\n`,
  );
  for (const name of partNames) {
    await rename(join(directory, name), join(directory, `${name}.merged`)).catch(
      () => undefined,
    );
  }

  // +1: the merge runs inside the orchestrator's final (handoff) turn, whose
  // assistant rows are typically not yet flushed to the transcript when this
  // executes — so the on-disk count is one turn short of the count the final
  // /tiered-compact run will see. Timing-dependent; the payload instructs
  // the orchestrator to sanity-check N against the flushed transcript.
  const recommendedN = turns.length - boundaryIndex + 1;
  console.log(
    JSON.stringify(
      {
        written: summariesPath(transcriptPath),
        turnsCovered: needed.length,
        parts: partNames.length,
        extrasIgnored: extras.length,
        recommendedCommand: `/tiered-compact ${recommendedN}${
          (await Bun.file(
            join(dirname(transcriptPath), "tiered-eras.json"),
          ).exists())
            ? " --eras"
            : ""
        }`,
        note: `Recommended N assumes exactly one more (handoff) turn before the user runs the command; scaffold-mark all other turns since the plan. File is ${SUMMARIES_FILENAME}.`,
      },
      null,
      2,
    ),
  );
}

// Mirrors compact.ts's private isCompactSummaryRow (upstream marker field).
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

await main();
