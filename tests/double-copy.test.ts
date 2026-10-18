import { describe, expect, test } from "bun:test";
import { buildCompactedRows, createPlan } from "../plugins/tiered-compact/src/compact";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, toolResultRow, toolUseBlock, userRow } from "./helpers";

/**
 * compact.ts double-copy: a summarized turn's
 * firstAssistant is emitted twice — as the summary row and, when it carries
 * tool blocks, again in the tool loop. When firstAssistant.parentUuid points
 * DIRECTLY at the user row (no intervening attachment — exactly what erosion
 * produces, and what any dropped row produces), the copiedUuids lookup HITS
 * the user row and the tool copy becomes the user row's SECOND child. Branch.
 * Measured on the eroded lineage: 61-81 rows unreachable, 6 turns lost.
 */
function branchCount(rows: TranscriptRow[]): number {
  const kids = new Map<string, number>();
  for (const r of rows) {
    if (r.parentUuid) kids.set(r.parentUuid, (kids.get(r.parentUuid) ?? 0) + 1);
  }
  return [...kids.values()].filter(v => v > 1).length;
}

describe("double-copy cannot branch the chain", () => {
  test("summarized turn with NO intervening row between user and tool-bearing assistant", async () => {
    const u1 = userRow("do the thing", null);
    const a1 = assistantRow([textBlock("on it"), toolUseBlock("t1", "Bash", { command: "ls" })], null);
    const r1 = toolResultRow("t1", "file.txt", null);
    const u2 = userRow("second turn", null);
    const a2 = assistantRow([textBlock("kept whole")], null);
    const rows = chainRows([[u1], [a1], [r1], [u2], [a2]]);
    // chainRows wires a1.parentUuid = u1.uuid — the eroded shape, no padding.
    const out = await buildCompactedRows(createPlan(rows, 1), ["summary text"], "new-session");
    expect(branchCount(out)).toBe(0);
  });

  test("intervening attachment present (the accidental padding) also stays linear", async () => {
    const u1 = userRow("do the thing", null);
    const pad: TranscriptRow = {
      type: "attachment",
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: "source-session",
      timestamp: new Date().toISOString(),
      attachment: { type: "total_tokens_reminder" },
    } as unknown as TranscriptRow;
    const a1 = assistantRow([textBlock("on it"), toolUseBlock("t2", "Bash", { command: "ls" })], null);
    const r1 = toolResultRow("t2", "file.txt", null);
    const u2 = userRow("second turn", null);
    const a2 = assistantRow([textBlock("kept whole")], null);
    const rows = chainRows([[u1], [pad], [a1], [r1], [u2], [a2]]);
    const out = await buildCompactedRows(createPlan(rows, 1), ["summary text"], "new-session");
    expect(branchCount(out)).toBe(0);
  });
});
