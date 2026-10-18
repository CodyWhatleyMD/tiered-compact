import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCompactedRows,
  createPlan,
} from "../plugins/tiered-compact/src/compact";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import {
  assistantRow,
  chainRows,
  textBlock,
  userRow,
} from "./helpers";

/**
 * The README makes a PUBLIC claim about the rows this plugin emits, and about
 * how they interoperate with someone else's software:
 *
 *   "marker rows are dual-stamped (`tieredCompact` + the upstream
 *    `magicCompact` field), so sessions compacted by either plugin remain
 *    mutually recompactable"
 *
 * A tree re-sync once reverted the dual-stamp and deleted the test that
 * covered it in the same pass, so the suite stayed green while the README
 * became false. Nothing stopped it. These tests exist to stop it: they assert
 * the emitted rows AND that the README still says what they implement.
 */

function syntheticRows(): TranscriptRow[] {
  const groups: TranscriptRow[][] = [];
  let parent: string | null = null;
  for (let i = 0; i < 6; i += 1) {
    const u = userRow(`question ${i}`, parent);
    const a = assistantRow([textBlock(`answer ${i} `.repeat(30))], u.uuid);
    parent = a.uuid;
    groups.push([u, a]);
  }
  return chainRows(groups);
}

async function compact() {
  const rows = syntheticRows();
  const plan = createPlan(rows, 1);
  const summaries = plan.summarizedTurns.map(() => "condensed");
  return await buildCompactedRows(plan, summaries, "destination-session-0003");
}

const marker = (row: TranscriptRow, field: string) =>
  (row as Record<string, any>)[field] as Record<string, unknown> | undefined;

describe("the interop promise, as emitted", () => {
  test("the boundary row is dual-stamped", async () => {
    const compacted = await compact();
    const boundary = compacted.find(r => marker(r, "magicCompact")?.["boundary"] === true);
    expect(boundary).toBeDefined();
    // upstream reads this one — dropping it breaks THEIR ability to recompact us
    expect(marker(boundary!, "magicCompact")?.["boundary"]).toBe(true);
    // ours — dropping it breaks the README
    expect(marker(boundary!, "tieredCompact")?.["boundary"]).toBe(true);
  });

  test("summary rows are dual-stamped", async () => {
    const compacted = await compact();
    const summaryRows = compacted.filter(
      r => marker(r, "magicCompact")?.["summary"] === true,
    );
    expect(summaryRows.length).toBeGreaterThan(0);
    for (const row of summaryRows) {
      expect(marker(row, "tieredCompact")?.["summary"]).toBe(true);
    }
  });

  test("the generation tag survives alongside the summary marker", async () => {
    const compacted = await compact();
    const summaryRows = compacted.filter(
      r => marker(r, "tieredCompact")?.["summary"] === true,
    );
    expect(summaryRows.length).toBeGreaterThan(0);
    for (const row of summaryRows) {
      // Adding `summary: true` by assignment would silently erase this, and
      // era separability depends on it.
      expect(marker(row, "tieredCompact")?.["gen"]).toBe("destination-session-0003");
    }
  });

  test("the README still claims what the code does", async () => {
    const readme = await readFile(join(import.meta.dir, "..", "README.md"), "utf8");
    const claimsDualStamp = /dual-stamped/i.test(readme);
    const claimsBothFields =
      readme.includes("tieredCompact") && readme.includes("magicCompact");
    // If you deliberately stop dual-stamping, rewrite the README bullet in the
    // same commit — then delete this test. Do not delete it to get to green.
    expect(claimsDualStamp && claimsBothFields).toBe(true);
  });

  test("the legacy upstream cache path is still consulted", async () => {
    const omission = await readFile(
      join(import.meta.dir, "..", "plugins", "tiered-compact", "src", "omission.ts"),
      "utf8",
    );
    // The other half of the README sentence: retrieval falls back to upstream's
    // cache directory, which is what makes THEIR compacted sessions readable here.
    expect(omission).toContain(".claude/magic-compact");
  });
});
