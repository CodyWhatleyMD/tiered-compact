import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildCompactedRows, createPlan, isScaffoldTurn, SCAFFOLD_MARKER } from "../plugins/riverbed-compact/src/compact";
import type { TranscriptRow } from "../plugins/riverbed-compact/src/transcript";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";

/**
 * Queued prompts reach the transcript ONLY as `queued_command` attachment rows
 * (no `message`), so the summarized-era copy loop dropped every one of them.
 * Measured on a 12.7MB fixture, keep=12, no flags: 11 in, 0 out — the human's
 * own words, destroyed on every compaction. Found in review, 2026-08-23.
 */
function queuedCommandRow(command: string, kind: string): TranscriptRow {
  return {
    type: "attachment",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: "source-session",
    timestamp: new Date().toISOString(),
    attachment: { type: "queued_command", origin: { kind }, command },
  } as unknown as TranscriptRow;
}

function planFor(rows: TranscriptRow[]) {
  return createPlan(rows, 1);
}

describe("queued human prompts survive compaction", () => {
  test("a human queued_command is carried into the compacted era", async () => {
    const rows = chainRows([
      [userRow("first", null)],
      [queuedCommandRow("check the third latch", "human")],
      [assistantRow([textBlock("work")], null)],
      [userRow("second", null)],
      [assistantRow([textBlock("kept whole")], null)],
    ]);
    const out = await buildCompactedRows(planFor(rows), ["summary"], "new-session");
    const kept = out.filter(
      r => (r as Record<string, any>)["attachment"]?.type === "queued_command",
    );
    expect(kept.length).toBe(1);
    expect((kept[0] as Record<string, any>)["attachment"].command).toBe(
      "check the third latch",
    );
  });

  test("a machine-origin queued_command is not carried", async () => {
    const rows = chainRows([
      [userRow("first", null)],
      [queuedCommandRow("agent chatter", "agent")],
      [assistantRow([textBlock("work")], null)],
      [userRow("second", null)],
      [assistantRow([textBlock("kept whole")], null)],
    ]);
    const out = await buildCompactedRows(planFor(rows), ["summary"], "new-session");
    expect(
      out.filter(r => (r as Record<string, any>)["attachment"]?.type === "queued_command")
        .length,
    ).toBe(0);
  });

  test("the rescued row does not branch the chain", async () => {
    const rows = chainRows([
      [userRow("first", null)],
      [queuedCommandRow("status?", "human")],
      [assistantRow([textBlock("work")], null)],
      [userRow("second", null)],
      [assistantRow([textBlock("kept whole")], null)],
    ]);
    const out = await buildCompactedRows(planFor(rows), ["summary"], "new-session");
    const kids = new Map<string, number>();
    for (const r of out) {
      if (r.parentUuid) kids.set(r.parentUuid, (kids.get(r.parentUuid) ?? 0) + 1);
    }
    expect([...kids.values()].filter(v => v > 1).length).toBe(0);
  });
});

// A queued prompt inside a SCAFFOLD turn is DISCARDED, on purpose.
//
// Scaffold turns are the compaction machinery. Something typed while that
// machinery runs was aimed at the context being replaced — usually "wait",
// "no", "stop" — and carrying it into the new session drops a dead imperative
// into the successor's recent history with nothing around it to date it.
//
// This branch is deliberately asymmetric with the summarized and era paths,
// which DO preserve queued prompts because those are conversation content.
// The asymmetry has been mistaken for an oversight and "fixed" once. These
// tests exist so the next person has to argue with a failing test rather than
// with a comment.
describe("queued prompts in a scaffold turn are discarded", () => {
  function withQueuedInScaffold(marker: string) {
    return chainRows([
      [userRow("first", null)],
      [assistantRow([textBlock("work")], null)],
      [userRow("second", null)],
      [queuedCommandRow(marker, "human")],
      [assistantRow([textBlock(`orchestrating ${SCAFFOLD_MARKER}`)], null)],
    ]);
  }

  test("typed-during-compaction input does not reach the new session", async () => {
    const rows = withQueuedInScaffold("MARKER-TYPED-DURING-COMPACTION");
    const plan = createPlan(rows, 1);
    expect(plan.preservedTurns.some(isScaffoldTurn)).toBe(true);
    const out = await buildCompactedRows(
      plan, plan.summarizedTurns.map(() => "s"), "dest-session",
    );
    expect(JSON.stringify(out)).not.toContain("MARKER-TYPED-DURING-COMPACTION");
  });

  test("but a queued prompt in an ORDINARY turn still survives", async () => {
    // The distinction the discard rule rests on: conversation content is kept,
    // machinery-directed input is not.
    const rows = chainRows([
      [userRow("first", null)],
      [queuedCommandRow("MARKER-REAL-CONTENT", "human")],
      [assistantRow([textBlock("work")], null)],
      [userRow("second", null)],
      [assistantRow([textBlock("kept whole")], null)],
    ]);
    const plan = createPlan(rows, 1);
    const out = await buildCompactedRows(
      plan, plan.summarizedTurns.map(() => "s"), "dest-session",
    );
    expect(JSON.stringify(out)).toContain("MARKER-REAL-CONTENT");
  });
});

/**
 * The merge/handoff turn used to be exempt from marking — the payload said
 * "do NOT scaffold-mark it" — which left the single turn holding the dispatch,
 * the merge call, its output and the injected payload as the one turn of the
 * compaction run guaranteed to survive. Measured on a real crossing: 50.5 KB, of which
 * 66% was tool I/O and 3% was prose and typed words.
 *
 * It is now detected STRUCTURALLY: a turn carrying this plugin's own injected
 * orchestration payload is machinery, whether or not the model marked it.
 */
describe("the orchestration turn is detected without a marker", () => {
  function payloadRow(header: string, parentUuid: string | null): TranscriptRow {
    const row = userRow("", parentUuid);
    delete row.message;
    row.type = "attachment" as TranscriptRow["type"];
    row["attachment"] = {
      type: "hook_additional_context",
      hookEvent: "UserPromptSubmit",
      content: [`${header} No summaries file exists yet, so nothing was compacted.`],
    };
    return row;
  }

  function turnWith(row: TranscriptRow) {
    const u = userRow("/riverbed-compact 12", null);
    const a = assistantRow([textBlock("orchestrating, no marker written")], null);
    return createPlan(chainRows([[userRow("earlier", null)],
                                 [assistantRow([textBlock("work")], null)],
                                 [u, row, a]]), 1);
  }

  test("an UNMARKED turn holding the compaction payload is scaffolding", () => {
    const plan = turnWith(payloadRow("[riverbed-compact]", null));
    expect(plan.preservedTurns.some(isScaffoldTurn)).toBe(true);
  });

  test("the --eras payload counts too", () => {
    const plan = turnWith(payloadRow("[riverbed-compact --eras]", null));
    expect(plan.preservedTurns.some(isScaffoldTurn)).toBe(true);
  });

  test("a DIFFERENT riverbed hook's injected context is NOT scaffolding", () => {
    // The resident-context watch fires on ordinary turns. Matching "[riverbed"
    // loosely would stub real conversation.
    const row = payloadRow("[riverbed] This session's resident context is", null);
    const plan = turnWith(row);
    expect(plan.preservedTurns.some(isScaffoldTurn)).toBe(false);
  });

  test("another tool's injected context is NOT scaffolding", () => {
    const row = payloadRow("Load and call some_other_tool instead of Grep", null);
    const plan = turnWith(row);
    expect(plan.preservedTurns.some(isScaffoldTurn)).toBe(false);
  });
});
