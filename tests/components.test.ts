/**
 * Multi-component transcripts.
 *
 * buildActiveChain finds branch-terminating rows, picks the newest, and walks
 * parentUuid back to a root. That returns ONE connected component. A transcript
 * that has been through a compaction usually holds two: the replayed history
 * hanging off the boundary row, and the live conversation hanging off its own
 * root. Nothing links them, so the founding history is silently absent from
 * every plan — not summarized away, standing in a tree nobody visits.
 *
 * Measured 2026-07-30 on a real transcript: 3,489 conversation rows in 2 components
 * (3,180 replayed + 309 live); the planner saw 35 turns and reported full
 * coverage. Corpus-wide across 163 transcripts on one machine: 192 components, 19 transcripts
 * with more than one, and in every one of those 19 file order agreed with
 * timestamp order — so ordering components by their earliest row is sound.
 * Zero wholly-sidechain components exist, so this cannot resurrect a
 * subagent's transcript into the main chain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAssistantTurns,
  componentSpansOverlap,
  readActiveTranscriptRows,
  type TranscriptRow,
} from "../plugins/tiered-compact/src/transcript";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

async function writeTranscript(rows: TranscriptRow[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tiered-components-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  await Bun.write(path, `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

let n = 0;
function pair(
  text: string,
  parentUuid: string | null,
  timestamp: string,
  extra: Record<string, unknown> = {},
): [TranscriptRow, TranscriptRow] {
  const u = `u${++n}`;
  const a = `a${n}`;
  return [
    {
      type: "user",
      uuid: u,
      parentUuid,
      sessionId: "s",
      timestamp,
      message: { role: "user", content: text },
      ...extra,
    } as TranscriptRow,
    {
      type: "assistant",
      uuid: a,
      parentUuid: u,
      sessionId: "s",
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: `re: ${text}` }] },
    } as TranscriptRow,
  ];
}

describe("multi-component transcripts", () => {
  test("default returns only the leaf's component (unchanged behaviour)", async () => {
    const older = pair("founding", null, "2026-07-29T17:00:00Z");
    const newer = pair("live", "dangling-never-defined", "2026-07-29T20:00:00Z");
    const path = await writeTranscript([...older, ...newer]);

    const rows = await readActiveTranscriptRows(path);
    const text = JSON.stringify(rows);
    expect(text).toContain("live");
    expect(text).not.toContain("founding");
    expect(buildAssistantTurns(rows)).toHaveLength(1);
  });

  test("reachPastBoundary returns every component", async () => {
    const older = pair("founding", null, "2026-07-29T17:00:00Z");
    const newer = pair("live", "dangling-never-defined", "2026-07-29T20:00:00Z");
    const path = await writeTranscript([...older, ...newer]);

    const rows = await readActiveTranscriptRows(path, { reachPastBoundary: true });
    const text = JSON.stringify(rows);
    expect(text).toContain("founding");
    expect(text).toContain("live");
    expect(buildAssistantTurns(rows)).toHaveLength(2);
  });

  test("components are ordered oldest-first regardless of file order", async () => {
    const older = pair("founding", null, "2026-07-29T17:00:00Z");
    const newer = pair("live", "dangling-never-defined", "2026-07-29T20:00:00Z");
    // newer component written FIRST in the file
    const path = await writeTranscript([...newer, ...older]);

    const rows = await readActiveTranscriptRows(path, { reachPastBoundary: true });
    const turns = buildAssistantTurns(rows);
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[0]!.rows)).toContain("founding");
    expect(JSON.stringify(turns[1]!.rows)).toContain("live");
  });

  test("a row is never duplicated across components", async () => {
    const a = pair("one", null, "2026-07-29T17:00:00Z");
    const b = pair("two", "dangling-x", "2026-07-29T18:00:00Z");
    const c = pair("three", "dangling-y", "2026-07-29T19:00:00Z");
    const path = await writeTranscript([...a, ...b, ...c]);

    const rows = await readActiveTranscriptRows(path, { reachPastBoundary: true });
    const uuids = rows.map(r => r.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(buildAssistantTurns(rows)).toHaveLength(3);
  });

  test("a single-component transcript is identical with and without the flag", async () => {
    const first = pair("hello", null, "2026-07-29T17:00:00Z");
    const second = pair("again", first[1].uuid, "2026-07-29T17:05:00Z");
    const path = await writeTranscript([...first, ...second]);

    const plain = await readActiveTranscriptRows(path);
    const reached = await readActiveTranscriptRows(path, { reachPastBoundary: true });
    expect(reached.map(r => r.uuid)).toEqual(plain.map(r => r.uuid));
  });

  test("componentSpansOverlap flags interleaved components", () => {
    const row = (ts: string): TranscriptRow =>
      ({ type: "user", uuid: `x${ts}`, parentUuid: null, sessionId: "s", timestamp: ts }) as TranscriptRow;
    const disjoint = [
      [row("2026-07-29T10:00:00Z"), row("2026-07-29T11:00:00Z")],
      [row("2026-07-29T12:00:00Z"), row("2026-07-29T13:00:00Z")],
    ];
    const overlapping = [
      [row("2026-07-29T10:00:00Z"), row("2026-07-29T14:00:00Z")],
      [row("2026-07-29T12:00:00Z"), row("2026-07-29T13:00:00Z")],
    ];
    expect(componentSpansOverlap(disjoint)).toBe(false);
    expect(componentSpansOverlap(overlapping)).toBe(true);
  });
});
