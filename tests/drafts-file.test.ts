import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestrationPayload } from "../plugins/tiered-compact/src/fork";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tiered-drafts-"));
  process.env["TIERED_COMPACT_DRAFTS_DIR"] = join(dir, "tiered-drafts");
});
afterAll(async () => {
  delete process.env["TIERED_COMPACT_DRAFTS_DIR"];
  await rm(dir, { recursive: true, force: true });
});

async function transcript(sid: string) {
  const users = [0, 1, 2].map(i => userRow(`question ${i}`, null));
  const rows: TranscriptRow[] = chainRows(users.map((u, i) => [[u], [assistantRow([textBlock(`answer ${i}`)], null)]]).flat());
  const path = join(dir, `${sid}.jsonl`);
  await writeFile(path, rows.map(r => JSON.stringify({ ...r, sessionId: sid })).join("\n") + "\n");
  return { path, users };
}

describe("pre-written drafts at a crossing", () => {
  test("drafted turns are marked, counted up front, and the request points at the file", async () => {
    const sid = "00000000-0000-4000-8000-0000000000d1";
    const { path, users } = await transcript(sid);
    await mkdir(join(dir, "tiered-drafts"), { recursive: true });
    await writeFile(join(dir, "tiered-drafts", `${sid}.json`), JSON.stringify({ summaries: { [users[0]!.uuid]: "draft of turn 0" } }));
    const payload = (await buildOrchestrationPayload(path, 1, { type: "inline" }))!;
    const head = payload.slice(0, 2000);
    expect(head).toContain("A drafts file already covers 1 of the 2 turns");
    expect(payload).toContain(`${join(dir, "tiered-drafts", `${sid}.json`)}, under "summaries"`);
    const turns = JSON.parse(payload.slice(payload.indexOf("turns: ") + 7));
    expect(turns.filter((t: { drafted?: boolean }) => t.drafted).length).toBe(1);
  });

  test("with no drafts file, the request reads as before", async () => {
    const sid = "00000000-0000-4000-8000-0000000000d2";
    const { path } = await transcript(sid);
    const payload = (await buildOrchestrationPayload(path, 1, { type: "inline" }))!;
    expect(payload).not.toContain("A drafts file");
    expect(payload).not.toContain('"drafted"');
  });
});
