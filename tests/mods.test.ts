import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { postCompactionNotice, SCAFFOLD_MARKER } from "../plugins/tiered-compact/src/compact";
import { carryDevMods, modsNotice } from "../plugins/tiered-compact/src/mods";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";

const HOOK_PATH = resolve(import.meta.dir, "../plugins/tiered-compact/src/hook.ts");
const OLD = "aaaaaaaa-1111-4111-8111-000000000001";
const NEW = "bbbbbbbb-2222-4222-8222-000000000002";

let root: string;
let modsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tiered-mods-"));
  modsDir = join(root, "dev-mods");
  process.env["TIERED_COMPACT_DEV_MODS_DIR"] = modsDir;
});

afterAll(async () => {
  delete process.env["TIERED_COMPACT_DEV_MODS_DIR"];
  await rm(root, { recursive: true, force: true });
});

async function makeMod(session: string, name: string): Promise<void> {
  await mkdir(join(modsDir, session, name, ".claude-plugin"), { recursive: true });
  await writeFile(join(modsDir, session, name, ".claude-plugin", "plugin.json"), `{"name":"${name}"}`);
  await mkdir(join(modsDir, session, name, "hooks"), { recursive: true });
  await writeFile(join(modsDir, session, name, "hooks", "register.ts"), "export const register = () => {}\n");
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("carrying mods across a crossing", () => {
  test("copies every mod folder to the new session and names them", async () => {
    await makeMod(OLD, "drafter");
    await makeMod(OLD, "band");
    await mkdir(join(modsDir, OLD, "not-a-mod"), { recursive: true });
    const carry = await carryDevMods(OLD, NEW);
    expect(carry).toEqual({ folder: join(modsDir, NEW), mods: ["band", "drafter"] });
    expect(await exists(join(modsDir, NEW, "drafter", "hooks", "register.ts"))).toBe(true);
    expect(await exists(join(modsDir, OLD, "drafter"))).toBe(true); // the old session keeps its own
  });

  test("never writes over a folder that already exists", async () => {
    await makeMod("cccccccc-3333-4333-8333-000000000003", "drafter");
    await makeMod("dddddddd-4444-4444-8444-000000000004", "drafter");
    await expect(carryDevMods("cccccccc-3333-4333-8333-000000000003", "dddddddd-4444-4444-8444-000000000004")).rejects.toThrow();
  });

  test("nothing to carry, or an id that could leave the mods root, carries nothing", async () => {
    expect(await carryDevMods("eeeeeeee-5555-4555-8555-000000000005", NEW)).toBeNull();
    expect(await carryDevMods("../" + OLD, "x")).toBeNull();
    expect(await carryDevMods(OLD, "../escape")).toBeNull();
    expect(await carryDevMods(OLD, OLD)).toBeNull();
  });

  test("the notice tells the successor to raise the question, and not to answer it", () => {
    const text = modsNotice({ folder: "/m/new", mods: ["a", "b"] });
    expect(text).toContain("(a, b)");
    expect(text).toContain("/m/new/");
    expect(text).toContain("load the plugin-authoring skill");
    expect(text).toContain("The answer is theirs.");
  });

  test("the boundary notice is unchanged without mods", () => {
    expect(postCompactionNotice()).toBe(
      "<post-compaction-notice>\nA compaction operation has just been applied to all messages above. You may have to reread certain files to regain context. Certain historical tool input/output may have been omitted due to length. If the exact I/O of the tool call needs to be retrieved and functionality cannot be replicated via a new tool call, call the read_omitted_content tool with the appropriate Content ID to reread the tool I/O content.\n</post-compaction-notice>",
    );
    expect(postCompactionNotice("EXTRA")).toContain("content.\n\nEXTRA\n</post-compaction-notice>");
  });
});

describe("hook end-to-end", () => {
  test("a crossing carries the mods, tells the successor, and writes no consent row", async () => {
    const session = "ffffffff-6666-4666-8666-000000000006";
    await makeMod(session, "drafter");
    const sessionDir = await mkdtemp(join(root, "crossing-"));
    const rows: TranscriptRow[] = chainRows([
      [
        userRow("Write the directive, then we compact", null),
        assistantRow([textBlock(`Directive written. ${SCAFFOLD_MARKER}`)], null),
      ],
    ]);
    const transcriptPath = join(sessionDir, `${session}.jsonl`);
    await writeFile(transcriptPath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);

    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: new TextEncoder().encode(JSON.stringify({
        session_id: session,
        transcript_path: transcriptPath,
        cwd: sessionDir,
        hook_event_name: "UserPromptSubmit",
        prompt: "/tiered-compact",
      })),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TIERED_COMPACT_CACHE_DIR: join(root, "cache"), TIERED_COMPACT_DEV_MODS_DIR: modsDir },
    });
    const output = JSON.parse(await new Response(proc.stdout).text()) as Record<string, unknown>;
    const stopReason = String(output["stopReason"]);
    expect(stopReason).toContain("Mods carried to the new session: drafter.");
    const destinationId = stopReason.split("claude --resume ")[1]!.split("\n")[0]!.trim();

    expect(await exists(join(modsDir, destinationId, "drafter", ".claude-plugin", "plugin.json"))).toBe(true);
    const destination = await readFile(join(sessionDir, `${destinationId}.jsonl`), "utf8");
    expect(destination).toContain("This session's mods (drafter) were copied to");
    expect(destination).toContain("The answer is theirs.");
    expect(destination.split("\n").some(line => line.includes('"type":"dev-mods"'))).toBe(false);
  });
});

describe("lineage", () => {
  test("the boundary row records the session it was compacted from", async () => {
    const session = "eeeeeeee-7777-4777-8777-000000000007";
    const sessionDir = await mkdtemp(join(root, "lineage-"));
    const rows: TranscriptRow[] = chainRows([
      [
        userRow("Write the directive, then we compact", null),
        assistantRow([textBlock(`Directive written. ${SCAFFOLD_MARKER}`)], null),
      ],
    ]).map(r => ({ ...r, sessionId: session }) as TranscriptRow);
    const transcriptPath = join(sessionDir, `${session}.jsonl`);
    await writeFile(transcriptPath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: session, transcript_path: transcriptPath, cwd: sessionDir, hook_event_name: "UserPromptSubmit", prompt: "/tiered-compact" })),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, TIERED_COMPACT_CACHE_DIR: join(root, "cache"), TIERED_COMPACT_DEV_MODS_DIR: modsDir },
    });
    const stopReason = String((JSON.parse(await new Response(proc.stdout).text()) as Record<string, unknown>)["stopReason"]);
    const destinationId = stopReason.split("claude --resume ")[1]!.split("\n")[0]!.trim();
    const out = (await readFile(join(sessionDir, `${destinationId}.jsonl`), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));
    const boundary = out.find(r => r.tieredCompact?.boundary);
    expect(boundary.originSessionId).toBe(session);
    expect(boundary.sessionId).toBe(destinationId);
  });
});
