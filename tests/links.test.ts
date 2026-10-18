/**
 * Link integrity of compaction output.
 *
 * The test class that was missing. Every prior test asserted on CONTENT — that
 * a summary landed, that a scaffold marker vanished. None asserted that the
 * references between rows still resolve afterwards, which is how two identity
 * bugs reached production unnoticed (uuid re-minting orphaning summaries, found
 * 2026-07-30 by hand).
 *
 * These load the rebuilt transcript and check that every uuid named by some
 * other row actually exists — parent chain, tool linkage, origin identity.
 *
 * One contract is pinned deliberately in the NEGATIVE: the boundary row's
 * logicalParentUuid names a row in the SOURCE session and must NOT resolve in
 * the output. That is not a dangling pointer; it is the session-lineage link,
 * and walking it across files reconstructs the chain of sessions. It was very
 * nearly "fixed" into uselessness on 2026-07-30 on the theory that a reference
 * which doesn't resolve locally must be broken. Verified against a real
 * five-session chain, each boundary resolving in exactly one predecessor
 * file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompactedRows, createPlan } from "../plugins/tiered-compact/src/compact";
import {
  originKey,
  type JsonRecord,
  type TranscriptRow,
} from "../plugins/tiered-compact/src/transcript";
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
  cacheDir = await mkdtemp(join(tmpdir(), "tiered-links-"));
  process.env["TIERED_COMPACT_CACHE_DIR"] = cacheDir;
});

afterAll(async () => {
  // Restore, never delete: the preload (tests/setup.ts) owns this variable,
  // and unsetting it here sent every LATER test file to the real cache.
  process.env["TIERED_COMPACT_CACHE_DIR"] = PRELOADED_CACHE_DIR;
  await rm(cacheDir, { recursive: true, force: true });
});

/** Four turns, two carrying tool calls, so tool linkage is exercised. */
function buildSource(): TranscriptRow[] {
  const t1u = userRow("Check the first log", null);
  const t1a = assistantRow(
    [textBlock("Pulling."), toolUseBlock("toolu_001", "Bash")],
    null,
  );
  const t1r = toolResultRow("toolu_001", "40 entries", null);
  const t2u = userRow("And the second one?", null);
  const t2a = assistantRow(
    [textBlock("Checking."), toolUseBlock("toolu_002", "Bash")],
    null,
  );
  const t2r = toolResultRow("toolu_002", "58.435", null);
  const t3u = userRow("What is the difference?", null);
  const t3a = assistantRow([textBlock("About half a percent.")], null);
  const t4u = userRow("Keep that", null);
  const t4a = assistantRow([textBlock("Kept.")], null);
  return chainRows([
    [t1u, t1a, t1r],
    [t2u, t2a, t2r],
    [t3u, t3a],
    [t4u, t4a],
  ]);
}

function blocksOf(row: TranscriptRow): JsonRecord[] {
  const content = (row.message ?? {})["content"];
  return Array.isArray(content) ? (content as JsonRecord[]) : [];
}

function collectToolUseIds(rows: TranscriptRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string") {
        ids.add(block["id"]);
      }
    }
  }
  return ids;
}

function collectToolResultIds(rows: TranscriptRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    for (const block of blocksOf(row)) {
      if (
        block["type"] === "tool_result"
        && typeof block["tool_use_id"] === "string"
      ) {
        ids.push(block["tool_use_id"]);
      }
    }
  }
  return ids;
}

/**
 * Compact, generating exactly as many summaries as the plan asks for.
 *
 * Counting them by hand made two of these tests fail on their first run for a
 * reason that had nothing to do with link integrity — the point here is the
 * references, not the summary bookkeeping.
 */
async function compactOnce(
  source: TranscriptRow[],
  keep: number,
  sessionId: string,
): Promise<TranscriptRow[]> {
  const plan = createPlan(source, keep);
  const summaries = plan.summarizedTurns.map((_, i) => `Summary ${i + 1}`);
  return buildCompactedRows(plan, summaries, sessionId);
}

describe("compaction output link integrity", () => {
  test("every parentUuid resolves to a row in the same output", async () => {
    const out = await compactOnce(
      buildSource(),
      2,
      "dest-links-1",
    );
    const uuids = new Set(out.map(row => row.uuid));
    const dangling = out
      .filter(row => row.parentUuid !== null && !uuids.has(row.parentUuid))
      .map(row => `${row.uuid} -> ${row.parentUuid}`);
    expect(dangling).toEqual([]);
  });

  test("exactly one root, and it is the boundary", async () => {
    const out = await compactOnce(
      buildSource(),
      2,
      "dest-links-2",
    );
    const roots = out.filter(row => row.parentUuid === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!["magicCompact"]).toEqual({ boundary: true });
  });

  test("the chain from the last row reaches the boundary", async () => {
    const out = await compactOnce(
      buildSource(),
      2,
      "dest-links-3",
    );
    const byUuid = new Map(out.map(row => [row.uuid, row]));
    let current: TranscriptRow | undefined = out.at(-1);
    const walked = new Set<string>();
    while (current && current.parentUuid) {
      expect(walked.has(current.uuid)).toBe(false);
      walked.add(current.uuid);
      current = byUuid.get(current.parentUuid);
    }
    expect(current).toBeDefined();
    expect(current!["magicCompact"]).toEqual({ boundary: true });
  });

  test("every tool_result has a matching tool_use in the same output", async () => {
    const out = await compactOnce(
      buildSource(),
      2,
      "dest-links-4",
    );
    const uses = collectToolUseIds(out);
    const orphans = collectToolResultIds(out).filter(id => !uses.has(id));
    expect(orphans).toEqual([]);
  });

  test("boundary logicalParentUuid names a SOURCE row, not an output row", async () => {
    const source = buildSource();
    const out = await compactOnce(
      source,
      2,
      "dest-links-5",
    );
    const boundary = out.find(row => row.parentUuid === null)!;
    const logical = boundary["logicalParentUuid"];
    expect(typeof logical).toBe("string");

    // Resolves in the SOURCE — this is the session-lineage link.
    expect(source.some(row => row.uuid === logical)).toBe(true);
    // And deliberately NOT in the output. Do not "fix" this.
    expect(out.some(row => row.uuid === logical)).toBe(false);
  });

  test("every copied row carries origin identity", async () => {
    const out = await compactOnce(
      buildSource(),
      2,
      "dest-links-6",
    );
    const copied = out.filter(row => row["magicCompact"] === undefined);
    expect(copied.length).toBeGreaterThan(0);
    for (const row of copied) {
      expect(originKey(row)).toBeTruthy();
    }
  });

  test("origin identity survives a SECOND compaction", async () => {
    const source = buildSource();
    const firstOrigins = new Set(source.map(row => row.uuid));

    const gen1 = await compactOnce(
      source,
      2,
      "dest-links-7a",
    );
    const gen2 = await compactOnce(
      gen1.filter(row => row["magicCompact"] === undefined),
      1,
      "dest-links-7b",
    );

    // Some row in gen2 still names an id from the ORIGINAL source.
    const survived = gen2.filter(row => firstOrigins.has(originKey(row)));
    expect(survived.length).toBeGreaterThan(0);
    // And no gen2 row's uuid equals its origin (they were all re-minted).
    for (const row of survived) {
      expect(row.uuid).not.toBe(originKey(row));
    }
  });

  test("link integrity holds after a second compaction too", async () => {
    const gen1 = await compactOnce(
      buildSource(),
      2,
      "dest-links-8a",
    );
    const gen2 = await compactOnce(
      gen1.filter(row => row["magicCompact"] === undefined),
      1,
      "dest-links-8b",
    );
    const uuids = new Set(gen2.map(row => row.uuid));
    const dangling = gen2.filter(
      row => row.parentUuid !== null && !uuids.has(row.parentUuid),
    );
    expect(dangling).toEqual([]);

    const uses = collectToolUseIds(gen2);
    expect(collectToolResultIds(gen2).filter(id => !uses.has(id))).toEqual([]);
  });
});
