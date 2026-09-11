import { describe, expect, test } from "bun:test";
import {
  buildAssistantTurns,
  type TranscriptRow,
} from "../plugins/riverbed-compact/src/transcript";
import { resolveTurnSummary } from "../plugins/riverbed-compact/src/summaries";
import { turnUserPreview } from "../plugins/riverbed-compact/src/fork";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";

/**
 * Claude Code's OWN /compact writes a recap row shaped almost exactly like a
 * human message: type "user", no isMeta, ~20k characters of generic summary.
 * It used to pass isHumanUserRow, which put it in the byte-faithful curated
 * layer — re-copied verbatim through every later compaction, as if the human
 * had typed it. One real session on the machine where this was found holds
 * four of them (18.5k / 18.4k / 19.5k / 22.5k chars).
 */
function nativeRecapRow(parentUuid: string | null): TranscriptRow {
  const row = userRow(
    "This session is being continued from a previous conversation that ran out "
      + "of context. The conversation is summarized below: …",
    parentUuid,
  );
  row["isCompactSummary"] = true;
  row["isVisibleInTranscriptOnly"] = true;
  return row;
}

function nativeBoundaryRow(parentUuid: string | null): TranscriptRow {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: `native-boundary-${parentUuid ?? "root"}`,
    parentUuid,
    sessionId: "source-session",
    timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, 0)).toISOString(),
    isMeta: false,
  };
}

describe("Claude Code's native /compact recap", () => {
  test("is not treated as a human message", () => {
    const a = userRow("real human question", null);
    const b = assistantRow([textBlock("real answer")], a.uuid);
    const boundary = nativeBoundaryRow(b.uuid);
    const recap = nativeRecapRow(boundary.uuid);
    const c = assistantRow([textBlock("post-compaction answer")], recap.uuid);

    const turns = buildAssistantTurns(chainRows([[a, b, boundary, recap, c]]));

    const allUserRows = turns.flatMap(turn => turn.userRows);
    expect(allUserRows.some(row => row["isCompactSummary"] === true))
      .toBe(false);
    // The human's actual message is still there.
    expect(allUserRows.map(row => row.uuid)).toContain(a.uuid);
  });

  test("does not start a turn of its own", () => {
    const a = userRow("human", null);
    const b = assistantRow([textBlock("answer")], a.uuid);
    const recap = nativeRecapRow(b.uuid);
    const c = assistantRow([textBlock("after")], recap.uuid);

    const turns = buildAssistantTurns(chainRows([[a, b, recap, c]]));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userRows.map(r => r.uuid)).toEqual([a.uuid]);
  });

  test("an ordinary user row is still human", () => {
    const a = userRow("ordinary", null);
    const b = assistantRow([textBlock("answer")], a.uuid);
    const turns = buildAssistantTurns(chainRows([[a, b]]));
    expect(turns[0]?.userRows.map(r => r.uuid)).toEqual([a.uuid]);
  });
});

/**
 * Consecutive human messages with no assistant reply between them fold into
 * ONE turn. 12.1% of turns in real transcripts are folded this way. An author
 * who reads them as separate exchanges writes a summary per message; every one
 * after the first used to be discarded in silence.
 */
describe("folded multi-message turns", () => {
  function foldedTurn() {
    const u1 = userRow("first message", null);
    const u2 = userRow("second message", u1.uuid);
    const u3 = userRow("third message", u2.uuid);
    const a = assistantRow([textBlock("one reply to all three")], u3.uuid);
    const turns = buildAssistantTurns(chainRows([[u1, u2, u3, a]]));
    return { u1, u2, u3, turns };
  }

  test("three messages with one reply are one turn", () => {
    const { turns } = foldedTurn();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userRows).toHaveLength(3);
  });

  test("conflicting summaries inside one turn are an error, not a silent drop", () => {
    const { u1, u2, turns } = foldedTurn();
    const file = {
      summaries: { [u1.uuid]: "summary of the first", [u2.uuid]: "summary of the second" },
    };
    expect(() => resolveTurnSummary(file, turns[0]!))
      .toThrow(/conflicting summaries for one turn/);
  });

  test("the same text under two keys is still accepted", () => {
    const { u1, u2, turns } = foldedTurn();
    const file = { summaries: { [u1.uuid]: "same text", [u2.uuid]: "same text" } };
    expect(resolveTurnSummary(file, turns[0]!)).toBe("same text");
  });

  test("one summary for the whole folded turn resolves", () => {
    const { u1, turns } = foldedTurn();
    const file = { summaries: { [u1.uuid]: "covers all three" } };
    expect(resolveTurnSummary(file, turns[0]!)).toBe("covers all three");
  });

  test("the preview shows every folded message, not just the first", () => {
    const { turns } = foldedTurn();
    const shown = turnUserPreview(turns[0]!);
    expect(shown).toContain("first message");
    expect(shown).toContain("second message");
    expect(shown).toContain("third message");
    expect(shown).toContain("3 messages");
  });

  test("an unfolded turn previews exactly as before", () => {
    const u = userRow("just the one", null);
    const a = assistantRow([textBlock("reply")], u.uuid);
    const turns = buildAssistantTurns(chainRows([[u, a]]));
    expect(turnUserPreview(turns[0]!)).toBe("just the one");
  });
});

/**
 * When an Agent/Task worker finishes, Claude Code writes its full report into
 * the PARENT transcript as type "user" with origin.kind "task-notification"
 * and promptSource "system" — and no isMeta. It therefore passed every test in
 * isHumanUserRow and was copied byte-faithfully into the tier that never
 * compresses. 5,538 such rows on the machine where this was found. It matters
 * doubly here because a compaction dispatches workers: the compaction run's own
 * subagent reports were being enshrined as the human's words.
 */
describe("system-authored user rows", () => {
  function taskNotification(parentUuid: string | null): TranscriptRow {
    const row = userRow(
      "<task-notification><result>agent report body</result></task-notification>",
      parentUuid,
    );
    row["origin"] = { kind: "task-notification" };
    row["promptSource"] = "system";
    return row;
  }

  test("a worker's task-notification is not the human's words", () => {
    const a = userRow("real question", null);
    const b = assistantRow([textBlock("dispatching")], a.uuid);
    const note = taskNotification(b.uuid);
    const c = assistantRow([textBlock("using the result")], note.uuid);

    const turns = buildAssistantTurns(chainRows([[a, b, note, c]]));
    const allUserRows = turns.flatMap(t => t.userRows);
    expect(allUserRows.some(r => r.uuid === note.uuid)).toBe(false);
    expect(allUserRows.map(r => r.uuid)).toContain(a.uuid);
  });

  test("promptSource system alone is enough", () => {
    const a = userRow("real question", null);
    const b = assistantRow([textBlock("work")], a.uuid);
    const sys = userRow("system-injected text", b.uuid);
    sys["promptSource"] = "system";
    const c = assistantRow([textBlock("after")], sys.uuid);
    const turns = buildAssistantTurns(chainRows([[a, b, sys, c]]));
    expect(turns.flatMap(t => t.userRows).some(r => r.uuid === sys.uuid)).toBe(false);
  });

  test("an ordinary typed row is still the human", () => {
    const a = userRow("typed by a person", null);
    a["promptSource"] = "typed";
    a["origin"] = { kind: "human" };
    const b = assistantRow([textBlock("reply")], a.uuid);
    const turns = buildAssistantTurns(chainRows([[a, b]]));
    expect(turns[0]?.userRows.map(r => r.uuid)).toEqual([a.uuid]);
  });

  test("a row from before these fields existed is still the human", () => {
    const a = userRow("older transcript, no promptSource", null);
    const b = assistantRow([textBlock("reply")], a.uuid);
    const turns = buildAssistantTurns(chainRows([[a, b]]));
    expect(turns[0]?.userRows.map(r => r.uuid)).toEqual([a.uuid]);
  });
});
