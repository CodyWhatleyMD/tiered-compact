import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompactedRows,
  createPlan,
  isScaffoldTurn,
  SCAFFOLD_MARKER,
} from "../plugins/tiered-compact/src/compact";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import {
  assistantRow,
  chainRows,
  textBlock,
  toolResultRow,
  toolUseBlock,
  userRow,
} from "./helpers";

const PRELOADED_CACHE_DIR = process.env["TIERED_COMPACT_CACHE_DIR"] as string;
let cacheDir: string;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "tiered-cache-"));
  process.env["TIERED_COMPACT_CACHE_DIR"] = cacheDir;
});

afterAll(async () => {
  // Restore, never delete: the preload (tests/setup.ts) owns this variable,
  // and unsetting it here sent every LATER test file to the real cache.
  process.env["TIERED_COMPACT_CACHE_DIR"] = PRELOADED_CACHE_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

/**
 * Synthetic 4-turn transcript:
 *   turn 1 — normal, with a tool call + result
 *   turn 2 — scaffold-marked assistant turn (the directive-writing turn)
 *   turn 3 — normal
 *   turn 4 — normal (candidate for preservation)
 */
function buildSyntheticRows(options?: {
  scaffoldLastTurn?: boolean;
}): TranscriptRow[] {
  const toolId = "toolu_001";
  const turn1 = [
    userRow("Check the log for June", null),
    assistantRow(
      [textBlock("Checking the log now."), toolUseBlock(toolId, "Bash")],
      null,
    ),
    toolResultRow(toolId, "log read: 40 days, deduped", null),
    assistantRow([textBlock("Log read and verified.")], null),
  ];
  const turn2 = [
    userRow("Write the tiered-compact directive before we compact", null),
    assistantRow(
      [
        textBlock(
          `Directive written to tiered-directive.md. ${SCAFFOLD_MARKER}`,
        ),
      ],
      null,
    ),
  ];
  const turn3 = [
    userRow("Re-run the threshold check", null),
    assistantRow([textBlock("Threshold re-run: 3 of 40 over the limit.")], null),
  ];
  const turn4 = [
    userRow("Summarize where we stand", null),
    assistantRow(
      [
        textBlock(
          options?.scaffoldLastTurn
            ? `Memory files updated, narration done. ${SCAFFOLD_MARKER}`
            : "Verified: 3 of 40 over the limit.",
        ),
      ],
      null,
    ),
  ];
  return chainRows([turn1, turn2, turn3, turn4]);
}

describe("isScaffoldTurn", () => {
  test("detects the literal marker in assistant text", () => {
    const rows = buildSyntheticRows();
    const plan = createPlan(rows, 0);
    expect(plan.summarizedTurns.length).toBe(4);
    expect(plan.summarizedTurns.map(isScaffoldTurn)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});

describe("scaffold drop in rebuilt rows", () => {
  test("summarized scaffold turn is dropped and replaced by a stub", async () => {
    const rows = buildSyntheticRows();
    const plan = createPlan(rows, 1); // preserve turn 4
    expect(plan.summarizedTurns.length).toBe(3);
    expect(plan.preservedTurns.length).toBe(1);

    // Summaries only for the non-scaffold summarized turns (1 and 3).
    const rebuilt = await buildCompactedRows(
      plan,
      ["Summary of turn 1", "Summary of turn 3"],
      "destination-session-0001",
    );

    const serialized = JSON.stringify(rebuilt);

    // The marker (and with it the scaffold turn's assistant content) is gone.
    expect(serialized).not.toContain(SCAFFOLD_MARKER);
    expect(serialized).not.toContain("Directive written to");

    // Exactly one one-line stub notes the removal.
    const stubs = rebuilt.filter(row => {
      const marker = row["tieredCompact"];
      return (
        typeof marker === "object"
        && marker !== null
        && (marker as Record<string, unknown>)["scaffold"] === true
      );
    });
    expect(stubs.length).toBe(1);
    expect(JSON.stringify(stubs[0]!.message)).toContain(
      "A scaffolding turn was removed here by tiered-compact.",
    );
    // Stubs are not summary rows (would move the recompaction boundary).
    expect(stubs[0]!["magicCompact"]).toBeUndefined();

    // The scaffold turn's user prompt survives verbatim.
    expect(serialized).toContain(
      "Write the tiered-compact directive before we compact",
    );

    // Non-scaffold turns got their summaries.
    expect(serialized).toContain("Summary of turn 1");
    expect(serialized).toContain("Summary of turn 3");

    // The preserved turn is intact.
    expect(serialized).toContain("Verified: 3 of 40 over the limit.");

    // Chain integrity: every row after the boundary links to a prior row.
    const uuids = new Set(rebuilt.map(row => row.uuid));
    for (const row of rebuilt.slice(1)) {
      expect(row.parentUuid === null || uuids.has(row.parentUuid!)).toBe(true);
    }
  });

  test("scaffold drop overrides keep-N preservation", async () => {
    const rows = buildSyntheticRows({ scaffoldLastTurn: true });
    const plan = createPlan(rows, 1); // turn 4 preserved — but it is scaffold
    expect(plan.preservedTurns.map(isScaffoldTurn)).toEqual([true]);

    const rebuilt = await buildCompactedRows(
      plan,
      ["Summary of turn 1", "Summary of turn 3"],
      "destination-session-0002",
    );

    const serialized = JSON.stringify(rebuilt);
    expect(serialized).not.toContain(SCAFFOLD_MARKER);
    expect(serialized).not.toContain("Memory files updated");
    expect(serialized).toContain(
      "A scaffolding turn was removed here by tiered-compact.",
    );
    // Its user prompt still survives.
    expect(serialized).toContain("Summarize where we stand");
  });

  test("non-scaffold rebuild leaves all turns intact (control)", async () => {
    const rows = buildSyntheticRows();
    const plan = createPlan(rows, 0);
    const nonScaffold = plan.summarizedTurns.filter(
      turn => !isScaffoldTurn(turn),
    );
    expect(nonScaffold.length).toBe(3);

    const rebuilt = await buildCompactedRows(
      plan,
      ["S1", "S3", "S4"],
      "destination-session-0003",
    );
    const serialized = JSON.stringify(rebuilt);
    expect(serialized).toContain("S1");
    expect(serialized).toContain("S3");
    expect(serialized).toContain("S4");
    expect(serialized).not.toContain(SCAFFOLD_MARKER);
  });
});
