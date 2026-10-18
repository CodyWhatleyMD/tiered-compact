import { describe, expect, test } from "bun:test";
import { isScaffoldTurn, SCAFFOLD_MARKER } from "../plugins/tiered-compact/src/compact";
import { buildAssistantTurns } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, toolUseBlock, userRow } from "./helpers";

const turnWith = (blocks: Record<string, unknown>[]) =>
  buildAssistantTurns(chainRows([[userRow("work on the plugin", null), assistantRow(blocks, null)]]))[0]!;

describe("what counts as claiming to be scaffolding", () => {
  test("a marker mentioned in thinking is discussion, not a claim: the turn is kept", () => {
    const turn = turnWith([
      { type: "thinking", thinking: `the rename rule must also map ${SCAFFOLD_MARKER} to the new stem`, signature: "s" },
      textBlock("Added the rename rules to the generator."),
    ]);
    expect(isScaffoldTurn(turn)).toBe(false);
  });

  test("a marker in the turn's text is a claim", () => {
    expect(isScaffoldTurn(turnWith([textBlock(`Dispatched. ${SCAFFOLD_MARKER}`)]))).toBe(true);
  });

  test("a marker in a tool call is a claim (the dispatch turn carries it there)", () => {
    expect(isScaffoldTurn(turnWith([toolUseBlock("t1", "Agent", { prompt: `summarize your turns ${SCAFFOLD_MARKER}` })]))).toBe(true);
  });
});
