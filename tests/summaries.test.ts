import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { shiftUncoveredTail, type Plan } from "../plugins/riverbed-compact/src/compact";
import {
  loadSummariesFile,
  resolveSummariesFromFile,
  resolveTurnSummary,
  summariesPath,
  transcriptId,
  turnKey,
} from "../plugins/riverbed-compact/src/summaries";
import type { Turn, TranscriptRow } from "../plugins/riverbed-compact/src/transcript";

function row(uuid: string): TranscriptRow {
  return {
    type: "assistant",
    uuid,
    parentUuid: null,
    sessionId: "s",
    timestamp: "2026-07-08T00:00:00Z",
  };
}

function turn(uuid: string, ...moreRowUuids: string[]): Turn {
  return { userRows: [], rows: [row(uuid), ...moreRowUuids.map(row)] };
}

describe("summaries file (mode B)", () => {
  test("resolves summaries in turn order by first-row uuid", () => {
    const turns = [turn("aaa"), turn("bbb")];
    const resolved = resolveSummariesFromFile(
      { summaries: { bbb: "second", aaa: "first", zzz: "unused-extra" } },
      turns,
    );
    expect(resolved).toEqual(["first", "second"]);
  });

  test("missing turn keys are a hard error naming the gaps", () => {
    expect(() =>
      resolveSummariesFromFile({ summaries: { aaa: "first" } }, [
        turn("aaa"),
        turn("bbb"),
      ]),
    ).toThrow(/missing 1 turn\(s\): bbb/);
  });

  test("turnKey is the first row's uuid", () => {
    expect(turnKey(turn("abc"))).toBe("abc");
  });

  test("any row uuid of the turn resolves its summary (assistant-row keying)", () => {
    // 2026-07-22 regression: the live instance keyed by assistant-row uuids,
    // not first-row uuids — 63/63 'missing' despite full coverage.
    const turns = [turn("user1", "asst1"), turn("user2", "asst2")];
    const resolved = resolveSummariesFromFile(
      { summaries: { asst1: "first", user2: "second" } },
      turns,
    );
    expect(resolved).toEqual(["first", "second"]);
  });

  test("missing-turn error counts orphan keys and teaches the contract", () => {
    expect(() =>
      resolveSummariesFromFile(
        { summaries: { wrong1: "a", wrong2: "b" } },
        [turn("user1", "asst1")],
      ),
    ).toThrow(/2 file key\(s\) match no needed turn/);
  });

  test("resolveTurnSummary returns null when no row matches", () => {
    expect(
      resolveTurnSummary({ summaries: { zzz: "x" } }, turn("a", "b")),
    ).toBeNull();
  });
});

describe("boundary drift tolerance", () => {
  function planOf(summarized: Turn[], preserved: Turn[]): Plan {
    return {
      prefixTurns: [],
      summarizedTurns: summarized,
      preservedTurns: preserved,
      baseRow: row("base"),
    };
  }

  test("uncovered contiguous tail shifts into the preserved region", () => {
    const covered = turn("c1");
    const late1 = turn("l1");
    const late2 = turn("l2");
    const kept = turn("k1");
    const plan = planOf([covered, late1, late2], [kept]);
    shiftUncoveredTail(plan, { summaries: { c1: "s" } });
    expect(plan.summarizedTurns).toEqual([covered]);
    expect(plan.preservedTurns).toEqual([late1, late2, kept]);
  });

  test("interior gap does NOT shift (stays a hard error downstream)", () => {
    const gap = turn("g1");
    const covered = turn("c1");
    const plan = planOf([gap, covered], []);
    shiftUncoveredTail(plan, { summaries: { c1: "s" } });
    expect(plan.summarizedTurns).toEqual([gap, covered]);
    expect(() =>
      resolveSummariesFromFile({ summaries: { c1: "s" } }, plan.summarizedTurns),
    ).toThrow(/missing 1 turn/);
  });

  test("fully covered plan is untouched", () => {
    const a = turn("a");
    const b = turn("b");
    const plan = planOf([a, b], []);
    shiftUncoveredTail(plan, { summaries: { a: "1", b: "2" } });
    expect(plan.summarizedTurns).toEqual([a, b]);
    expect(plan.preservedTurns).toEqual([]);
  });
});

describe("transcript stamp (wrong-tab guard, 2026-08-18)", () => {
  const here = "/tmp/rb-stamp/aaaaaaaa-1111-2222-3333-444444444444.jsonl";

  test("accepts a file stamped for this transcript", async () => {
    await Bun.write(
      summariesPath(here),
      JSON.stringify({
        transcript: "aaaaaaaa-1111-2222-3333-444444444444",
        summaries: { "k-1": "kept" },
      }),
    );
    const file = await loadSummariesFile(here);
    expect(file?.summaries["k-1"]).toBe("kept");
  });

  test("rejects a file stamped for a different session, naming both", async () => {
    await Bun.write(
      summariesPath(here),
      JSON.stringify({
        transcript: "bbbbbbbb-9999-8888-7777-666666666666",
        summaries: { "k-1": "another thread's night" },
      }),
    );
    await expect(loadSummariesFile(here)).rejects.toThrow(
      /prepared for session bbbbbbbb-9999-8888-7777-666666666666.*neither this session \(aaaaaaaa-1111-2222-3333-444444444444\) nor an ancestor/s,
    );
  });

  test("unstamped files still load (backward compatible)", async () => {
    await Bun.write(
      summariesPath(here),
      JSON.stringify({ summaries: { "k-1": "legacy" } }),
    );
    const file = await loadSummariesFile(here);
    expect(file?.summaries["k-1"]).toBe("legacy");
  });

  test("a non-string stamp is a hard error", async () => {
    await Bun.write(
      summariesPath(here),
      JSON.stringify({ transcript: 42, summaries: { "k-1": "x" } }),
    );
    await expect(loadSummariesFile(here)).rejects.toThrow(/"transcript" must be/);
  });

  test("transcriptId strips the .jsonl suffix", () => {
    expect(transcriptId("/x/y/zzzz-1.jsonl")).toBe("zzzz-1");
  });
});

describe("lineage-aware stamps (2026-08-30)", () => {
  // Session ids drift between authoring and assembly. A stamp naming a
  // provable ANCESTOR (its id appears in this transcript's rows) is honored;
  // a stranger's stamp is still refused. The negative control is the point:
  // the loosening must not have widened the gate to wrong-tab files.
  const dir2 = tmpdir() + "/lineage-" + Math.random().toString(36).slice(2);
  const cur = `${dir2}/cccccccc-1111-2222-3333-444444444444.jsonl`;

  test("a stamp naming an ancestor found in the transcript is honored", async () => {
    await Bun.write(
      cur,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "dddddddd-0000-aaaa-bbbb-000000000000",
        timestamp: "t",
        message: { role: "user", content: "carried row from the ancestor" },
      }) + "\n",
    );
    await Bun.write(
      summariesPath(cur),
      JSON.stringify({
        transcript: "dddddddd-0000-aaaa-bbbb-000000000000",
        summaries: { "k-1": "authored before the compaction" },
      }),
    );
    const file = await loadSummariesFile(cur);
    expect(file?.summaries["k-1"]).toBe("authored before the compaction");
  });

  test("NEGATIVE CONTROL: a stranger's stamp is still refused", async () => {
    await Bun.write(
      summariesPath(cur),
      JSON.stringify({
        transcript: "eeeeeeee-5555-6666-7777-888888888888",
        summaries: { "k-1": "someone else's night" },
      }),
    );
    await expect(loadSummariesFile(cur)).rejects.toThrow(/neither this session/);
  });
});
