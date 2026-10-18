import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactTranscript, createPlan } from "../plugins/tiered-compact/src/compact";
import { collapseCandidates, isEraStubRow, splitPrefixIntoEras } from "../plugins/tiered-compact/src/eras";
import { readOmittedContent } from "../plugins/tiered-compact/src/omission";
import { readTranscriptRows, readActiveTranscriptRows, buildAssistantTurns } from "../plugins/tiered-compact/src/transcript";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, toolResultRow, toolUseBlock, userRow } from "./helpers";

const PRELOADED_CACHE_DIR = process.env["TIERED_COMPACT_CACHE_DIR"] as string;
// Without this the suite writes omission caches into the REAL
// ~/.claude/tiered-compact/ — three files per run, accumulating in the
// user's own directory. Synthetic session ids, so nothing collided, but the
// README promised "never real sessions" and this was the file making that
// false.
let eraCacheDir: string;
beforeAll(async () => {
  eraCacheDir = await mkdtemp(join(tmpdir(), "tiered-eras-cache-"));
  process.env["TIERED_COMPACT_CACHE_DIR"] = eraCacheDir;
});
afterAll(async () => {
  // Restore, never delete: the preload (tests/setup.ts) owns this variable,
  // and unsetting it here sent every LATER test file to the real cache.
  process.env["TIERED_COMPACT_CACHE_DIR"] = PRELOADED_CACHE_DIR;
  await rm(eraCacheDir, { recursive: true, force: true });
});

/**
 * Era-collapse gates (the era-collapse design notes):
 *  1. every user row of a collapsed era survives byte-identical
 *  2. the authored stub text lands in the transcript exactly
 *  3. zero branches
 *  4. the era Content ID resolves to the era's full original rows
 * Built on a REAL two-generation lineage: source -> compact (gen1) -> the
 * gen1 output re-compacted with --eras. The prefix-era structure is produced
 * by the machinery itself, not hand-forged.
 */
async function writeTranscript(dir: string, sessionId: string, rows: TranscriptRow[]): Promise<string> {
  const path = join(dir, `${sessionId}.jsonl`);
  await Bun.write(path, rows.map(r => JSON.stringify({ ...r, sessionId })).join("\n") + "\n");
  return path;
}

function makeSource(): TranscriptRow[] {
  const groups: TranscriptRow[][] = [];
  for (let i = 0; i < 6; i++) {
    groups.push([userRow(`question ${i}: the exact human words ${i}`, null)]);
    groups.push([assistantRow([textBlock(`long era prose for turn ${i} `.repeat(20)), toolUseBlock(`t${i}`, "Bash", { command: `echo ${i}` })], null)]);
    groups.push([toolResultRow(`t${i}`, `output ${i}`, null)]);
  }
  groups.push([userRow("final question", null)]);
  groups.push([assistantRow([textBlock("final answer, kept whole")], null)]);
  return chainRows(groups);
}

describe("splitPrefixIntoEras", () => {
  test("adjacent summary runs merge into one era (inherent granularity loss)", () => {
    // When generation g+1 summarizes from exactly where generation g's run
    // ended, the runs are contiguous and generation identity is erased. One
    // era covers both; the live author sees this in the payload listing.
    const mk = (marked: boolean): any => {
      const u = userRow("q", null);
      const a = assistantRow([textBlock("prose")], null);
      if (marked) (a as any).magicCompact = { summary: true };
      return { userRows: [u], rows: [u, a] };
    };
    const eras = splitPrefixIntoEras([mk(true), mk(true), mk(true)] as any);
    expect(eras.length).toBe(1);
  });

  test("separated runs split into distinct eras", () => {
    const mk = (marked: boolean): any => {
      const u = userRow("q", null);
      const a = assistantRow([textBlock("prose")], null);
      if (marked) (a as any).magicCompact = { summary: true };
      return { userRows: [u], rows: [u, a] };
    };
    const eras = splitPrefixIntoEras(
      [mk(true), mk(false), mk(false), mk(true), mk(false)] as any,
    );
    expect(eras.length).toBe(2);
    expect(eras[0]!.turns.length).toBe(3);
    expect(eras[1]!.turns.length).toBe(2);
  });
});

describe("era-collapse on a mature transcript", () => {
  test("gates 1-4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eras-"));
    try {
      // A mature transcript's real shape: [sum run A][preserved-forever A][sum run B]
      // [recent turns]. Runs A and B are separated by former keep-N turns that
      // no pass ever summarized — the exact disease era-collapse treats.
      const groups: TranscriptRow[][] = [];
      const sum = (i: number) => {
        const u = userRow(`old question ${i}: the exact human words ${i}`, null);
        const a = assistantRow([textBlock(`summary of ancient turn ${i}`)], null);
        (a as any).magicCompact = { summary: true };
        return [[u], [a]];
      };
      const plain = (i: number, tag: string) => {
        const u = userRow(`${tag} question ${i}: the exact human words ${tag}-${i}`, null);
        const a = assistantRow([textBlock(`full-fidelity ${tag} prose ${i} `.repeat(20)), toolUseBlock(`${tag}${i}`, "Bash", { command: "ls" })], null);
        const r = toolResultRow(`${tag}${i}`, "out", null);
        return [[u], [a], [r]];
      };
      for (let i = 0; i < 3; i++) groups.push(...sum(i));
      for (let i = 0; i < 4; i++) groups.push(...plain(i, "eraA"));
      for (let i = 10; i < 12; i++) groups.push(...sum(i));
      for (let i = 0; i < 3; i++) groups.push(...plain(i, "recent"));
      const sid = "00000000-0000-4000-8000-0000000000m0";
      const src = join(dir, `${sid}.jsonl`);
      await Bun.write(src, chainRows(groups).map(r => JSON.stringify({ ...r, sessionId: sid })).join("\n") + "\n");

      const plan = createPlan(await readActiveTranscriptRows(src), 2);
      const eras = splitPrefixIntoEras(plan.prefixTurns);
      expect(eras.length).toBe(2);
      const candidates = collapseCandidates(eras, 1);
      expect(candidates.length).toBe(1);

      // summaries for whatever needs summarizing this pass
      await Bun.write(join(dir, "tiered-summaries.json"), JSON.stringify({ transcript: sid, summaries: Object.fromEntries(plan.summarizedTurns.map(t => [t.rows.find(r => r.type === "assistant")!.uuid, "fresh summary"])) }));
      const texts = { [candidates[0]!.key]: "ERA STUB: the eraA arc — diagnostic cue text, pinned lines exact" };
      const dstId = "00000000-0000-4000-8000-0000000000m1";
      const dst = join(dir, `${dstId}.jsonl`);
      const userWordsBefore = (await readTranscriptRows(src))
        .filter(r => r.type === "user" && !(r as any).isMeta)
        .map(r => JSON.stringify((r as any).message?.content))
        .filter(c => c && c.includes("exact human words"));
      expect(userWordsBefore.length).toBeGreaterThan(0);
      expect(await compactTranscript(src, dst, dstId, 2, null, { keepNewest: 1, texts })).not.toBeNull();

      const out = await readTranscriptRows(dst);
      // gate 3: zero branches
      const kids = new Map<string, number>();
      for (const r of out) if (r.parentUuid) kids.set(r.parentUuid, (kids.get(r.parentUuid) ?? 0) + 1);
      expect([...kids.values()].filter(v => v > 1).length).toBe(0);
      // gate 1: every user row byte-identical, INCLUDING the collapsed era's
      const outUser = out.map(r => JSON.stringify((r as any).message?.content) ?? "");
      for (const w of userWordsBefore) expect(outUser.some(c => c === w)).toBe(true);
      // gate 2: stub present with authored text; collapsed prose gone from transcript
      const stubs = out.filter(isEraStubRow);
      expect(stubs.length).toBe(1);
      expect(JSON.stringify(stubs[0])).toContain("ERA STUB");
      expect(out.some(r => JSON.stringify(r).includes("full-fidelity eraA prose"))).toBe(false);
      // gate 4: content id resolves to the era's full original rows
      const eraMeta = (stubs[0] as any).tieredCompact.era;
      expect(typeof eraMeta.contentId).toBe("string");
      // and the stub TEXT names the same id, so a live reader can retrieve it
      expect(JSON.stringify((stubs[0] as any).message.content)).toContain(eraMeta.contentId);
      const recovered = await readOmittedContent(eraMeta.contentId);
      expect(recovered).not.toBeNull();
      expect(recovered!).toContain("full-fidelity eraA prose");
      expect(recovered!).toContain("exact human words eraA");
      // SECOND PASS: the transcript re-collapses. Stubs are boundaries, not poison —
      // the old rule ("an era containing a stub is done") fused a live transcript
      // into one immune 508-turn era (observed 2026-08-27). Pass 2 must find
      // candidates among what pass 1 kept, and pass-1 stubs must survive it.
      const plan2 = createPlan(await readActiveTranscriptRows(dst), 1);
      const eras2 = splitPrefixIntoEras(plan2.prefixTurns);
      const candidates2 = collapseCandidates(eras2, 1);
      expect(candidates2.length).toBeGreaterThan(0);
      const texts2 = Object.fromEntries(candidates2.map(e => [e.key, `ERA STUB PASS2: ${e.key.slice(0, 8)}`]));
      await Bun.write(join(dir, "tiered-summaries.json"), JSON.stringify({ transcript: dstId, summaries: Object.fromEntries(plan2.summarizedTurns.map(t => [t.rows.find(r => r.type === "assistant")!.uuid, "pass2 summary"])) }));
      const dst2Id = "00000000-0000-4000-8000-0000000000m2";
      const dst2 = join(dir, `${dst2Id}.jsonl`);
      expect(await compactTranscript(dst, dst2, dst2Id, 1, null, { keepNewest: 1, texts: texts2 })).not.toBeNull();
      const out2 = await readTranscriptRows(dst2);
      // pass-1 stub survived pass 2, byte-visible
      expect(out2.some(r => JSON.stringify(r).includes("ERA STUB: the eraA arc"))).toBe(true);
      // pass-2 stubs landed
      expect(out2.some(r => JSON.stringify(r).includes("ERA STUB PASS2"))).toBe(true);
      // still zero branches
      const kids2 = new Map<string, number>();
      for (const r of out2) if (r.parentUuid) kids2.set(r.parentUuid, (kids2.get(r.parentUuid) ?? 0) + 1);
      expect([...kids2.values()].filter(v => v > 1).length).toBe(0);
      // and user words STILL byte-identical after two collapses
      const outUser2 = out2.map(r => JSON.stringify((r as any).message?.content) ?? "");
      for (const w of userWordsBefore) expect(outUser2.some(c => c === w)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("eras file auto-use (the dropped-flag hole)", () => {
  test("a valid stamped eras file is honored even without --eras", async () => {
    // The final command is printed by merge.ts and historically carried no
    // --eras; on 2026-08-27 a fully authored era file sat ignored while the
    // session was compacted at 950k. The file's presence is the intent.
    const dir = await mkdtemp(join(tmpdir(), "eras-auto-"));
    try {
      const groups: TranscriptRow[][] = [];
      const sum = (i: number) => {
        const u = userRow(`old q ${i}`, null);
        const a = assistantRow([textBlock(`summary ${i}`)], null);
        (a as any).magicCompact = { summary: true };
        return [[u], [a]];
      };
      const plain = (i: number, tag: string) => {
        const u = userRow(`${tag} q ${i}`, null);
        const a = assistantRow([textBlock(`${tag} prose ${i} `.repeat(10))], null);
        return [[u], [a]];
      };
      for (let i = 0; i < 2; i++) groups.push(...sum(i));
      for (let i = 0; i < 3; i++) groups.push(...plain(i, "eraA"));
      for (let i = 10; i < 12; i++) groups.push(...sum(i));
      for (let i = 0; i < 2; i++) groups.push(...plain(i, "recent"));
      const sid = "00000000-0000-4000-8000-0000000000a0";
      const src = join(dir, `${sid}.jsonl`);
      await Bun.write(src, chainRows(groups).map(r => JSON.stringify({ ...r, sessionId: sid })).join("\n") + "\n");
      const plan = createPlan(await readActiveTranscriptRows(src), 2);
      const candidates = collapseCandidates(splitPrefixIntoEras(plan.prefixTurns), 1);
      expect(candidates.length).toBeGreaterThan(0);
      await Bun.write(join(dir, "tiered-summaries.json"), JSON.stringify({ transcript: sid, summaries: Object.fromEntries(plan.summarizedTurns.map(t => [t.rows.find(r => r.type === "assistant")!.uuid, "s"])) }));
      await Bun.write(join(dir, "tiered-eras.json"), JSON.stringify({ transcript: sid, eras: Object.fromEntries(candidates.map(e => [e.key, "AUTO-USED STUB"])) }));
      // simulate the hook's auto-use path: eras=null but the file exists
      const { loadErasFile } = await import("../plugins/tiered-compact/src/eras");
      const erasFile = await loadErasFile(src);
      expect(erasFile).not.toBeNull();
      const dst = join(dir, "00000000-0000-4000-8000-0000000000a1.jsonl");
      expect(await compactTranscript(src, dst, "00000000-0000-4000-8000-0000000000a1", 2, null, { keepNewest: 1, texts: erasFile!.eras })).not.toBeNull();
      const out = await readTranscriptRows(dst);
      expect(out.some(r => JSON.stringify(r).includes("AUTO-USED STUB"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
