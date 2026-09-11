/**
 * Origin identity across compactions.
 *
 * compact.ts re-mints `uuid` on every copied row. Summaries are keyed by turn
 * uuid. Before originUuid existed, that meant a summary became unlinkable at
 * the exact moment its turn was compacted — the moment it started mattering.
 * Found 2026-07-30 after a compaction dropped a founding conversation and the
 * 63 summaries covering it could not be re-attached to anything.
 *
 * The invariant these tests pin: origin identity is set on the FIRST copy and
 * never overwritten, so a summary written on day 1 still resolves after any
 * number of subsequent compactions.
 */
import { describe, expect, test } from "bun:test";
import { originKey, type TranscriptRow, type Turn } from "../plugins/riverbed-compact/src/transcript";
import { resolveTurnSummary, turnKey } from "../plugins/riverbed-compact/src/summaries";

function row(uuid: string, originUuid?: string): TranscriptRow {
  const r: TranscriptRow = {
    type: "assistant",
    uuid,
    parentUuid: null,
    sessionId: "s",
    timestamp: "2026-07-30T00:00:00Z",
  };
  if (originUuid !== undefined) {
    r.originUuid = originUuid;
  }
  return r;
}

function turn(...rows: TranscriptRow[]): Turn {
  return { rows, userRows: [], assistantRows: rows } as unknown as Turn;
}

/** What compact.ts's copyRow does to identity, isolated. */
function copyIdentity(source: TranscriptRow, newUuid: string): TranscriptRow {
  const copied = structuredClone(source);
  copied.originUuid = originKey(source);
  copied.uuid = newUuid;
  return copied;
}

describe("origin identity", () => {
  test("a never-compacted row's origin IS its uuid", () => {
    expect(originKey(row("a"))).toBe("a");
  });

  test("first copy records the original id", () => {
    const first = copyIdentity(row("original"), "copy-1");
    expect(first.uuid).toBe("copy-1");
    expect(originKey(first)).toBe("original");
  });

  test("origin survives repeated compactions unchanged", () => {
    let r = row("original");
    for (let i = 1; i <= 5; i++) {
      r = copyIdentity(r, `copy-${i}`);
    }
    expect(r.uuid).toBe("copy-5");
    expect(originKey(r)).toBe("original");
  });

  test("empty originUuid falls back to uuid rather than keying on \"\"", () => {
    expect(originKey(row("a", ""))).toBe("a");
  });

  test("turnKey is stable across a compaction", () => {
    const before = turn(row("first-row"), row("second-row"));
    const after = turn(
      copyIdentity(row("first-row"), "new-1"),
      copyIdentity(row("second-row"), "new-2"),
    );
    expect(turnKey(before)).toBe(turnKey(after));
  });

  test("a summary written before a compaction still resolves after it", () => {
    const file = { summaries: { "first-row": "the founding" } };
    const compacted = turn(
      copyIdentity(row("first-row"), "new-1"),
      copyIdentity(row("second-row"), "new-2"),
    );
    expect(resolveTurnSummary(file, compacted)).toBe("the founding");
  });

  test("...and after five of them", () => {
    const file = { summaries: { "first-row": "the founding" } };
    let r = row("first-row");
    for (let i = 1; i <= 5; i++) {
      r = copyIdentity(r, `gen-${i}`);
    }
    expect(resolveTurnSummary(file, turn(r))).toBe("the founding");
  });

  test("current-uuid keying still works (back-compat with existing files)", () => {
    const file = { summaries: { "live-uuid": "written this session" } };
    expect(resolveTurnSummary(file, turn(row("live-uuid")))).toBe(
      "written this session",
    );
  });

  test("an unrelated turn does not resolve", () => {
    const file = { summaries: { "first-row": "the founding" } };
    expect(resolveTurnSummary(file, turn(row("somewhere-else")))).toBeNull();
  });
});
