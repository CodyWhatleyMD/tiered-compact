import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelKind, pointerLine } from "../plugins/tiered-compact/src/channel";
import { compactTranscript, createPlan } from "../plugins/tiered-compact/src/compact";
import { collapseCandidates, loadErasFile, splitPrefixIntoEras } from "../plugins/tiered-compact/src/eras";
import { readOmittedContent } from "../plugins/tiered-compact/src/omission";
import { readActiveTranscriptRows, readTranscriptRows } from "../plugins/tiered-compact/src/transcript";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, toolResultRow, toolUseBlock, userRow } from "./helpers";

const PRELOADED_CACHE_DIR = process.env["TIERED_COMPACT_CACHE_DIR"] as string;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tiered-channel-"));
  process.env["TIERED_COMPACT_CACHE_DIR"] = join(dir, "cache");
});
afterAll(async () => {
  process.env["TIERED_COMPACT_CACHE_DIR"] = PRELOADED_CACHE_DIR;
  await rm(dir, { recursive: true, force: true });
});

const NOTE = "Here is a note offered by a side agent:\n\n> Heads up · Usage credits shrink the cache to 5 minutes\n> * details...";

describe("what in the person's channel is their words", () => {
  test("a forwarded side-agent note, command output and a harness notice are told apart from typing", () => {
    // Stamped exactly like typing, as the client stamps them.
    const stamped = (text: string) => ({ ...userRow(text, null), promptSource: "typed", origin: { kind: "human" } }) as TranscriptRow;
    expect(channelKind(stamped(NOTE))).toBe("side-agent note");
    expect(channelKind(stamped("<local-command-stdout>(no content)</local-command-stdout>"))).toBe("command output");
    expect(channelKind(stamped("Your response above was stopped by a safety classifier — this is not a tool error."))).toBe("harness notice");
    expect(channelKind(stamped("I said look"))).toBe("typed");
    expect(channelKind(stamped('a thought\n<pasted_content id="x">pasted text</pasted_content id="x">'))).toBe("typed"); // pastes sit in typed rows: kept
  });

  test("a pointer line names its source and where the original is", () => {
    const line = pointerLine("side-agent note", userRow(NOTE, null), "abcdef123456:omitted-007");
    expect(line).toContain("a side agent's note the person forwarded");
    expect(line).toContain('read_omitted_content("abcdef123456:omitted-007")');
    expect(line).toContain("Heads up");
  });

  test("the eras file reads an optional pointers list, and refuses a malformed one", async () => {
    const sid = "00000000-0000-4000-8000-0000000000c0";
    const t = join(dir, `${sid}.jsonl`);
    await writeFile(t, "");
    await writeFile(join(dir, "tiered-eras.json"), JSON.stringify({ transcript: sid, eras: { k: "stub" }, pointers: ["a", "b"] }));
    expect((await loadErasFile(t))?.pointers).toEqual(["a", "b"]);
    await writeFile(join(dir, "tiered-eras.json"), JSON.stringify({ transcript: sid, eras: { k: "stub" }, pointers: "a" }));
    await expect(loadErasFile(t)).rejects.toThrow("pointers");
    await rm(join(dir, "tiered-eras.json"));
  });
});

describe("pointers at era collapse", () => {
  test("a listed side-agent note becomes a pointer to the era's full rows; a listed typed row stays whole", async () => {
    const groups: TranscriptRow[][] = [];
    const sum = (i: number) => {
      const a = assistantRow([textBlock(`summary of ancient turn ${i}`)], null);
      (a as any).magicCompact = { summary: true };
      return [[userRow(`old question ${i}`, null)], [a]];
    };
    let noteRow: TranscriptRow | undefined;
    let typedRow: TranscriptRow | undefined;
    const plain = (i: number, tag: string, text?: string) => {
      const u = userRow(text ?? `${tag} question ${i}: the exact human words ${tag}-${i}`, null);
      if (tag === "eraA" && i === 1) noteRow = u;
      if (tag === "eraA" && i === 2) typedRow = u;
      const a = assistantRow([textBlock(`${tag} prose ${i} `.repeat(10)), toolUseBlock(`${tag}${i}`, "Bash", { command: "ls" })], null);
      return [[u], [a], [toolResultRow(`${tag}${i}`, "out", null)]];
    };
    for (let i = 0; i < 3; i++) groups.push(...sum(i));
    for (let i = 0; i < 4; i++) groups.push(...plain(i, "eraA", i === 1 ? NOTE : undefined));
    for (let i = 10; i < 12; i++) groups.push(...sum(i));
    for (let i = 0; i < 3; i++) groups.push(...plain(i, "recent"));
    const sid = "00000000-0000-4000-8000-0000000000c1";
    const src = join(dir, `${sid}.jsonl`);
    await Bun.write(src, chainRows(groups).map(r => JSON.stringify({ ...r, sessionId: sid })).join("\n") + "\n");

    const plan = createPlan(await readActiveTranscriptRows(src), 2);
    const candidates = collapseCandidates(splitPrefixIntoEras(plan.prefixTurns), 1);
    expect(candidates.length).toBe(1);
    await Bun.write(join(dir, "tiered-summaries.json"), JSON.stringify({ transcript: sid, summaries: Object.fromEntries(plan.summarizedTurns.map(t => [t.rows.find(r => r.type === "assistant")!.uuid, "fresh summary"])) }));
    const dstId = "00000000-0000-4000-8000-0000000000c2";
    const dst = join(dir, `${dstId}.jsonl`);
    const inventory = await compactTranscript(src, dst, dstId, 2, null, {
      keepNewest: 1,
      texts: { [candidates[0]!.key]: "ERA STUB: eraA" },
      pointers: [noteRow!.uuid, typedRow!.uuid],
    });
    expect(inventory?.pointersCarried).toBe(1);
    expect(inventory?.pointersRefused).toBe(1);

    const out = await readTranscriptRows(dst);
    const stub = out.find(r => (r as any).tieredCompact?.era) as any;
    const contentId: string = stub.tieredCompact.era.contentId;
    const pointered = out.filter(r => (r as any).tieredCompact?.pointer) as any[];
    expect(pointered.length).toBe(1);
    expect(pointered[0].originUuid).toBe(noteRow!.uuid);
    expect(pointered[0].message.content).toContain("a side agent's note the person forwarded");
    expect(pointered[0].message.content).toContain(`read_omitted_content("${contentId}")`);
    expect(out.some(r => JSON.stringify((r as any).message?.content) === JSON.stringify(NOTE))).toBe(false); // the full note no longer rides
    expect(out.some(r => (r as any).originUuid === typedRow!.uuid && JSON.stringify((r as any).message.content).includes("the exact human words eraA-2"))).toBe(true);
    expect(await readOmittedContent(contentId)).toContain("Usage credits shrink the cache"); // the original, word for word
    await rm(join(dir, "tiered-summaries.json"), { force: true });
  });
});
