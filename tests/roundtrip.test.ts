/**
 * END-TO-END ROUND-TRIP: what actually SURVIVES a compaction.
 *
 * Why this file exists. On 2026-07-30 a compaction ran, reported
 * `turnsCovered: 11, extrasIgnored: 0` — full coverage, no gaps — and the
 * session that came out the other side had lost a founding conversation.
 * Every existing test passed. They all test PLANNING (which turns get picked,
 * how summaries resolve) and none of them ran a compaction and asked the only
 * question that matters: is the content still there afterwards?
 *
 * These tests run the real compactTranscript() against temp files and assert
 * on the OUTPUT. A test here fails when content goes missing, whatever the
 * planner says about coverage.
 *
 * On the mechanism, since the first diagnosis was wrong and the wrong version
 * is easy to re-derive: the 1,193 rows before the boundary in the measured transcript were
 * session METADATA (mode / permission-mode / last-prompt / custom-title /
 * agent-name), not conversation, and were never lost. The founding was at row
 * 3355, AFTER the boundary, present in the file the whole time. What made it
 * invisible is that real transcripts BRANCH: that file had 144 leaves, and
 * buildActiveChain walks back from the newest one, reaching 542 of 4,286
 * conversation rows. The other 3,744 were off-chain. Content loss here is a
 * REACHABILITY problem, not a truncation one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompactedRows,
  compactTranscript,
  createPlan,
  isScaffoldTurn,
  SCAFFOLD_MARKER,
} from "../plugins/riverbed-compact/src/compact";
import {
  buildAssistantTurns,
  readActiveTranscriptRows,
  readTranscriptRows,
} from "../plugins/riverbed-compact/src/transcript";
import { turnKey } from "../plugins/riverbed-compact/src/summaries";
import { readOmittedContent } from "../plugins/riverbed-compact/src/omission";
import {
  buildTranscript,
  readEntries,
  resetClock,
  transcriptText,
  writeSummaries,
  writeTranscript,
  type BuildSpec,
} from "./transcript-builder";

const PRELOADED_CACHE_DIR = process.env["RIVERBED_COMPACT_CACHE_DIR"] as string;

let dir: string;
let cacheDir: string;
let seq = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "riverbed-roundtrip-"));
  cacheDir = await mkdtemp(join(tmpdir(), "riverbed-cache-"));
  process.env["RIVERBED_COMPACT_CACHE_DIR"] = cacheDir;
});

afterAll(async () => {
  // Restore, never delete: the preload (tests/setup.ts) owns this variable,
  // and unsetting it here sent every LATER test file to the real cache.
  process.env["RIVERBED_COMPACT_CACHE_DIR"] = PRELOADED_CACHE_DIR;
  await rm(dir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetClock();
});

/** Fresh temp path per compaction so nothing bleeds between tests. */
function nextPaths(): { src: string; dst: string; sessionId: string } {
  seq += 1;
  const sub = join(dir, `case-${seq}`);
  return {
    src: join(sub, "source.jsonl"),
    dst: join(sub, "dest.jsonl"),
    sessionId: `dest-session-${seq}`,
  };
}

/**
 * Build → write → auto-author summaries for every turn that needs one →
 * compact. Returns the output entries plus what the planner thought it did.
 */
async function roundTrip(
  spec: BuildSpec,
  keepTurns: number,
  summaryFor: (marker: string, i: number) => string = (m, i) =>
    `[summary ${i}] covering: ${m}`,
) {
  const { src, dst, sessionId } = nextPaths();
  const built = buildTranscript(spec);
  await writeTranscript(src, built.entries);

  const activeRows = await readActiveTranscriptRows(src);
  const plan = createPlan(activeRows, keepTurns);
  const summaries: Record<string, string> = {};
  plan.summarizedTurns
    .filter(turn => !isScaffoldTurn(turn))
    .forEach((turn, i) => {
      const firstUser = turn.userRows[0];
      const text = firstUser
        ? String((firstUser.message as { content?: unknown })?.content ?? "")
        : `turn-${i}`;
      summaries[turnKey(turn)] = summaryFor(text, i);
    });
  if (Object.keys(summaries).length > 0) {
    await writeSummaries(src, summaries);
  }

  const changed = (await compactTranscript(src, dst, sessionId, keepTurns)) !== null;
  const outEntries = changed ? await readEntries(dst) : [];
  return {
    built,
    plan,
    changed,
    out: outEntries,
    outText: transcriptText(outEntries),
    src,
    dst,
    summaries,
    counts: {
      prefix: plan.prefixTurns.length,
      summarized: plan.summarizedTurns.length,
      preserved: plan.preservedTurns.length,
      activeConversationRows: activeRows.length,
    },
  };
}

function turns(n: number, tag = "t") {
  return Array.from({ length: n }, (_, i) => ({
    user: `USER-${tag}-${i}-marker`,
    assistant: `ASSISTANT-${tag}-${i}-marker`,
  }));
}

// ---------------------------------------------------------------------------
// 1. The basic guarantee: a compaction does not silently delete content.
// ---------------------------------------------------------------------------

describe("round-trip: content survives", () => {
  test("a pinned verbatim in turn 1 is still present after compaction", async () => {
    const pinned = "the blue door on the third landing";
    const spec: BuildSpec = {
      metadata: 12,
      turns: [
        { user: pinned, assistant: "Noted." },
        ...turns(9),
      ],
    };
    const r = await roundTrip(spec, 4);

    expect(r.changed).toBe(true);
    // Turn 1 is summarized, not preserved — so the verbatim survives inside
    // the summary text we authored for it. Either way it must be findable.
    expect(r.outText).toContain(pinned);
  });

  test("preserved turns survive byte-for-byte", async () => {
    const r = await roundTrip({ turns: turns(10) }, 4);
    // The last 4 turns ride whole.
    for (let i = 6; i < 10; i++) {
      expect(r.outText).toContain(`USER-t-${i}-marker`);
      expect(r.outText).toContain(`ASSISTANT-t-${i}-marker`);
    }
  });

  test("summarized turns keep their USER rows verbatim", async () => {
    const r = await roundTrip({ turns: turns(10) }, 4);
    // compact.ts copies userRows verbatim and replaces only the assistant
    // side with the summary. Cody's words are the thing that must not blur.
    for (let i = 0; i < 6; i++) {
      expect(r.outText).toContain(`USER-t-${i}-marker`);
    }
  });

  test("every summary authored is present in the output", async () => {
    const r = await roundTrip({ turns: turns(10) }, 4);
    for (const summary of Object.values(r.summaries)) {
      expect(r.outText).toContain(summary);
    }
  });

  test("scaffold turns become stubs, not silent deletions", async () => {
    const { src, dst, sessionId } = nextPaths();
    const built = buildTranscript({
      turns: [
        ...turns(3),
        { user: "orchestrate please", assistant: `dispatching ${SCAFFOLD_MARKER}` },
        ...turns(3, "tail"),
      ],
    });
    await writeTranscript(src, built.entries);
    const rows = await readActiveTranscriptRows(src);
    const plan = createPlan(rows, 2);
    const summaries: Record<string, string> = {};
    plan.summarizedTurns
      .filter(t => !isScaffoldTurn(t))
      .forEach((t, i) => (summaries[turnKey(t)] = `[s${i}]`));
    await writeSummaries(src, summaries);
    await compactTranscript(src, dst, sessionId, 2);
    const outText = transcriptText(await readEntries(dst));
    // The scaffold turn's user row survives; its assistant body is stubbed.
    expect(outText).toContain("orchestrate please");
    expect(outText).toMatch(/scaffolding turn was removed/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Conservation. Every non-scaffold input turn must be ACCOUNTED FOR.
//    This is the check whose absence let an amputation report full coverage.
// ---------------------------------------------------------------------------

describe("round-trip: conservation", () => {
  test("every non-scaffold turn is verbatim, summarized, or stubbed — none unaccounted", async () => {
    const spec: BuildSpec = { metadata: 8, turns: turns(12) };
    const r = await roundTrip(spec, 5);

    const planned =
      r.counts.prefix + r.counts.summarized + r.counts.preserved;
    const inputTurns = buildAssistantTurns(
      await readActiveTranscriptRows(r.src),
    ).length;

    // Nothing may fall between the cracks of the three buckets.
    expect(planned).toBe(inputTurns);

    // And every input turn's user marker must appear somewhere in the output.
    const unaccounted: string[] = [];
    for (let i = 0; i < 12; i++) {
      const marker = `USER-t-${i}-marker`;
      if (!r.outText.includes(marker)) unaccounted.push(marker);
    }
    expect(unaccounted).toEqual([]);
  });

  test("conservation holds when keepTurns exceeds the transcript", async () => {
    const r = await roundTrip({ turns: turns(3) }, 99);
    // Nothing to summarize → compaction is a no-op, and that is honest.
    expect(r.changed).toBe(false);
  });

  test("the output's own conversation-row count is never zero after a real compaction", async () => {
    const r = await roundTrip({ turns: turns(8) }, 3);
    const rows = await readTranscriptRows(r.dst);
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-generation. The case that actually bit: content survives one
//    compaction, then disappears at the next.
// ---------------------------------------------------------------------------

describe("round-trip: successive generations", () => {
  test("a verbatim survives TWO compactions", async () => {
    const pinned = "seventeen amber lanterns";
    const gen1 = await roundTrip(
      { metadata: 6, turns: [{ user: pinned, assistant: "noted" }, ...turns(9)] },
      4,
      marker => `[gen1 summary] ${marker}`,
    );
    expect(gen1.outText).toContain(pinned);

    // Now compact the OUTPUT — the generational step.
    const { dst: dst2, sessionId: s2 } = nextPaths();
    const rows2 = await readActiveTranscriptRows(gen1.dst);
    const plan2 = createPlan(rows2, 3);
    const summaries2: Record<string, string> = {};
    plan2.summarizedTurns
      .filter(t => !isScaffoldTurn(t))
      .forEach((t, i) => {
        const first = t.userRows[0];
        const text = first
          ? String((first.message as { content?: unknown })?.content ?? "")
          : "";
        summaries2[turnKey(t)] = `[gen2 summary] ${text}`;
      });
    if (Object.keys(summaries2).length > 0) {
      await writeSummaries(gen1.dst, summaries2);
    }
    const changed2 = (await compactTranscript(gen1.dst, dst2, s2, 3)) !== null;
    expect(changed2).toBe(true);
    const out2 = transcriptText(await readEntries(dst2));

    // The verbatim rode in a USER row, which is copied verbatim at every
    // generation. If this ever fails, user words are being blurred away.
    expect(out2).toContain(pinned);
  });

  test("origin identity is stamped so gen-2 summaries can key on gen-1 turns", async () => {
    const gen1 = await roundTrip({ turns: turns(8) }, 3);
    const rows = await readTranscriptRows(gen1.dst);
    const copied = rows.filter(r => typeof r["originUuid"] === "string");
    // the origin-identity fix: copyRow carries originUuid. Without it a summary written
    // against a turn becomes unlinkable the moment that turn is compacted.
    expect(copied.length).toBeGreaterThan(0);
  });

  test("origin identity is IDEMPOTENT across generations", async () => {
    const gen1 = await roundTrip({ turns: turns(8) }, 3);
    const rows1 = await readTranscriptRows(gen1.dst);
    const originsGen1 = new Set(
      rows1.map(r => (r["originUuid"] as string) ?? r.uuid),
    );

    const { dst: dst2, sessionId: s2 } = nextPaths();
    const rows2 = await readActiveTranscriptRows(gen1.dst);
    const plan2 = createPlan(rows2, 1);
    const sums: Record<string, string> = {};
    plan2.summarizedTurns
      .filter(t => !isScaffoldTurn(t))
      .forEach((t, i) => (sums[turnKey(t)] = `[g2-${i}]`));
    if (Object.keys(sums).length > 0) await writeSummaries(gen1.dst, sums);
    await compactTranscript(gen1.dst, dst2, s2, 2);

    const rows3 = await readTranscriptRows(dst2);
    const originsGen2 = rows3
      .map(r => r["originUuid"] as string | undefined)
      .filter((v): v is string => typeof v === "string");
    // Every gen-2 origin must be an origin gen-1 already knew: origins are
    // set once and carried, never re-minted at each hop.
    const reminted = originsGen2.filter(o => !originsGen1.has(o));
    expect(reminted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The real failure mode: content present in the file, off the active chain.
// ---------------------------------------------------------------------------

describe("round-trip: off-chain content (the 2026-07-30 loss)", () => {
  test("a branched transcript has conversation rows the planner never sees", async () => {
    const { src } = nextPaths();
    const built = buildTranscript({
      metadata: 10,
      turns: turns(6, "main"),
      branch: { afterTurn: 1, turns: turns(5, "founding") },
    });
    await writeTranscript(src, built.entries);

    const allRows = await readTranscriptRows(src);
    const activeRows = await readActiveTranscriptRows(src);

    // The branch rows are real conversation, in the file, and unreachable.
    expect(allRows.length).toBeGreaterThan(activeRows.length);
    const offChain = allRows.length - activeRows.length;
    expect(offChain).toBeGreaterThan(0);
  });

  /**
   * DOCUMENTS CURRENT BROKEN BEHAVIOUR — asserts the CORRECT outcome and is
   * expected to fail until reachability is fixed.
   *
   * Off-chain conversation is dropped with no error, no warning, and no count.
   * This is precisely the 2026-07-30 loss: content in the file, absent from
   * the output, and a planner reporting full coverage.
   *
   * When the fix lands, remove `.failing` — bun will flag a `.failing` test
   * that starts passing, which is the prompt to do so.
   */
  test.failing(
    "off-chain content is either carried forward or reported — never silently dropped",
    async () => {
      const { src, dst, sessionId } = nextPaths();
      const built = buildTranscript({
        metadata: 10,
        turns: turns(6, "main"),
        branch: { afterTurn: 1, turns: turns(5, "founding") },
      });
      await writeTranscript(src, built.entries);

      const rows = await readActiveTranscriptRows(src);
      const plan = createPlan(rows, 2);
      const sums: Record<string, string> = {};
      plan.summarizedTurns
        .filter(t => !isScaffoldTurn(t))
        .forEach((t, i) => (sums[turnKey(t)] = `[s${i}]`));
      if (Object.keys(sums).length > 0) await writeSummaries(src, sums);
      await compactTranscript(src, dst, sessionId, 2);

      const outText = transcriptText(await readEntries(dst));
      const missing = built.branchMarkers.filter(m => !outText.includes(m));
      expect(missing).toEqual([]);
    },
  );

  /**
   * DOCUMENTS CURRENT BROKEN BEHAVIOUR — expected to fail until fixed.
   *
   * Silence is the real defect. Even if a policy decision is made NOT to carry
   * off-chain branches, dropping them must be VISIBLE. `turnsCovered: 11,
   * extrasIgnored: 0` on a transcript with thousands of off-chain rows is a
   * clean bill of health on an amputation.
   */
  test.failing(
    "the plan reports how many conversation rows it could not reach",
    async () => {
      const { src } = nextPaths();
      const built = buildTranscript({
        turns: turns(6, "main"),
        branch: { afterTurn: 1, turns: turns(5, "founding") },
      });
      await writeTranscript(src, built.entries);

      const allRows = await readTranscriptRows(src);
      const activeRows = await readActiveTranscriptRows(src);
      const plan = createPlan(activeRows, 2) as unknown as Record<string, unknown>;

      // There is currently no such field anywhere in the Plan.
      expect(plan["unreachableRows"]).toBe(allRows.length - activeRows.length);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Shapes that LOOK like loss and are not — so a future reader does not
//    re-derive the wrong diagnosis we spent a morning on.
// ---------------------------------------------------------------------------

describe("round-trip: false alarms", () => {
  test("metadata rows before a boundary are not conversation and are not 'lost'", async () => {
    const { src } = nextPaths();
    const built = buildTranscript({
      metadata: 1193, // the exact count that read as a lost founding
      turns: turns(5),
    });
    await writeTranscript(src, built.entries);

    const allEntries = await readEntries(src);
    const conversation = await readTranscriptRows(src);

    expect(allEntries.length).toBeGreaterThan(1193);
    // None of those 1,193 are conversation: no uuid, not user/assistant.
    expect(conversation.length).toBe(built.markers.length);
  });

  test("a dangling logicalParentUuid is normal, not corruption", async () => {
    const { src } = nextPaths();
    const built = buildTranscript({
      turns: turns(6),
      boundaryAfterTurn: 2,
    });
    await writeTranscript(src, built.entries);
    const entries = await readEntries(src);
    const boundary = entries.find(
      e => (e["magicCompact"] as { boundary?: boolean } | undefined)?.boundary,
    );
    expect(boundary).toBeDefined();
    const logical = boundary!["logicalParentUuid"] as string;
    const uuids = new Set(entries.map(e => e["uuid"]).filter(Boolean));
    // It points at a pre-copy id, so it does not resolve in this file. Real
    // boundary rows are written exactly this way; do not "fix" it by chasing
    // the pointer, and do not rely on it to cross the seam.
    expect(uuids.has(logical)).toBe(false);
  });

  test("compaction after a boundary still preserves the newest turns", async () => {
    const r = await roundTrip(
      { metadata: 20, turns: turns(10), boundaryAfterTurn: 3 },
      3,
    );
    expect(r.changed).toBe(true);
    for (let i = 7; i < 10; i++) {
      expect(r.outText).toContain(`USER-t-${i}-marker`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The prefix era. Turns inherited from PRIOR compactions — in a long-lived
//    lineage, the overwhelming majority: measured 2026-08-10, 477 of 528
//    turns, carrying ~229k tokens of tool I/O that copyTurnRows reproduced
//    byte-faithful forever. The refined invariant: prefix TEXT stays
//    byte-faithful (summaries, verbatims, user words — the curated layer),
//    prefix TOOL rows take the deep tier.
// ---------------------------------------------------------------------------

describe("round-trip: the prefix era", () => {
  const FAT_INPUT = "z".repeat(3000);
  const FAT_OUTPUT = `prefix-tool-output-marker ${"payload ".repeat(400)}`;
  /** Distinct payload: AskUserQuestion is exempt, so its bulk MUST survive. */
  const ASK_INPUT = `ASK-PAYLOAD-marker ${"q".repeat(3000)}`;

  /** A transcript that already has history behind it: two prefix turns with
   * fat tool I/O, the second marked as a prior compaction's summary. */
  function withPrefix(): BuildSpec {
    return {
      metadata: 4,
      turns: [
        {
          user: "USER-prefix-0-marker",
          assistant: "PREFIX-ASSISTANT-TEXT-0-marker",
          tool: {
            name: "Bash",
            input: { command: FAT_INPUT, description: "prefix bash" },
            output: FAT_OUTPUT,
          },
        },
        {
          user: "USER-prefix-1-marker",
          assistant: "PREFIX-SUMMARY-TEXT-marker",
          tool: {
            name: "mcp__example__do_thing",
            input: { content: FAT_INPUT },
            output: FAT_OUTPUT,
          },
        },
        {
          user: "USER-prefix-2-marker",
          assistant: "PREFIX-LAST-SUMMARY-marker",
          priorSummary: true,
          tool: {
            name: "AskUserQuestion",
            input: { questions: [{ question: ASK_INPUT }] },
            output: "user chose option A",
          },
        },
        ...turns(10),
      ],
    };
  }

  function contentIds(text: string): string[] {
    return [...text.matchAll(/read_omitted_content\(\\?"([\w-]+:omitted-\d+)/g)]
      .map(m => m[1] as string);
  }

  test("prefix TEXT stays byte-faithful, prefix TOOL I/O is deep-pruned", async () => {
    const r = await roundTrip(withPrefix(), 2);
    expect(r.counts.prefix).toBe(3);

    // The curated layer, untouched.
    for (const marker of [
      "USER-prefix-0-marker",
      "PREFIX-ASSISTANT-TEXT-0-marker",
      "USER-prefix-1-marker",
      "PREFIX-SUMMARY-TEXT-marker",
      "USER-prefix-2-marker",
      "PREFIX-LAST-SUMMARY-marker",
    ]) {
      expect(r.outText).toContain(marker);
    }

    // The archaeology underneath it, gone from resident context.
    expect(r.outText).not.toContain(FAT_INPUT);
    expect(r.outText).not.toContain("prefix-tool-output-marker");
    expect(r.outText).toContain("Bash output omitted");
    expect(r.outText).toContain("do_thing input omitted");
  });

  test("AskUserQuestion in the prefix era is still untouched", async () => {
    const r = await roundTrip(withPrefix(), 2);
    // The one tool whose input is the conversation, not archaeology.
    expect(r.outText).toContain(ASK_INPUT);
    expect(r.outText).toContain("user chose option A");
  });

  test("every newly-pruned prefix omission retrieves byte-exact", async () => {
    const r = await roundTrip(withPrefix(), 2);
    const ids = [...new Set(contentIds(r.outText))];
    // Two prefix tool calls x (input + output); AskUserQuestion contributes none.
    expect(ids.length).toBeGreaterThanOrEqual(4);

    const retrieved = await Promise.all(ids.map(id => readOmittedContent(id)));
    for (const content of retrieved) {
      expect(content).not.toBeNull();
    }
    expect(retrieved).toContain(FAT_OUTPUT);
    expect(retrieved).toContain(
      JSON.stringify({ command: FAT_INPUT, description: "prefix bash" }),
    );
    expect(retrieved).toContain(JSON.stringify({ content: FAT_INPUT }));
  });

  test("a second compaction leaves the prefix notices byte-identical", async () => {
    // Idempotence at the level that matters: the prefix era is re-walked at
    // every generation forever. If a notice can be re-pruned, the lineage
    // accretes a hop of indirection per compaction and the original bytes
    // become unreachable.
    const gen1 = await roundTrip(withPrefix(), 2);
    const idsGen1 = [...new Set(contentIds(gen1.outText))].sort();
    const noticesGen1 =
      gen1.outText.match(
        /\[[^[\]]*read_omitted_content\(\\"[\w-]+:omitted-\d+\\"\)\]/g,
      ) ?? [];
    // Guard against a vacuous loop below: there must BE notices to compare.
    expect(noticesGen1.length).toBeGreaterThanOrEqual(4);

    const { dst: dst2, sessionId: s2 } = nextPaths();
    const rows2 = await readActiveTranscriptRows(gen1.dst);
    const plan2 = createPlan(rows2, 1);
    const summaries2: Record<string, string> = {};
    plan2.summarizedTurns
      .filter(t => !isScaffoldTurn(t))
      .forEach(t => {
        summaries2[turnKey(t)] = "[gen2 summary]";
      });
    if (Object.keys(summaries2).length > 0) {
      await writeSummaries(gen1.dst, summaries2);
    }
    // keep-1: gen1's summary rows push the prefix boundary to turn 11 of 13,
    // so keep-2 would leave nothing to summarize and compaction would no-op.
    expect(await compactTranscript(gen1.dst, dst2, s2, 1)).not.toBeNull();
    const out2 = transcriptText(await readEntries(dst2));

    // Same IDs, no new hop, and the notices themselves are byte-identical.
    expect([...new Set(contentIds(out2))].sort()).toEqual(idsGen1);
    for (const notice of noticesGen1) {
      expect(out2).toContain(notice);
    }
    // And the curated layer still is what it was.
    expect(out2).toContain("PREFIX-ASSISTANT-TEXT-0-marker");
    expect(out2).toContain("USER-prefix-0-marker");
  });
});
