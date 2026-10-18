import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCAFFOLD_MARKER } from "../plugins/tiered-compact/src/compact";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";

const HOOK_PATH = resolve(
  import.meta.dir,
  "../plugins/tiered-compact/src/hook.ts",
);

let workDir: string;
let cacheDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tiered-hook-"));
  cacheDir = await mkdtemp(join(tmpdir(), "tiered-hook-cache-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

async function runHook(input: Record<string, unknown>): Promise<{
  stdout: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TIERED_COMPACT_CACHE_DIR: cacheDir, TIERED_COMPACT_DEV_MODS_DIR: join(cacheDir, "dev-mods"), TIERED_COMPACT_DRAFTS_DIR: join(cacheDir, "tiered-drafts") },
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

function hookInput(
  transcriptPath: string,
  prompt: string,
): Record<string, unknown> {
  return {
    session_id: "hook-test-session",
    transcript_path: transcriptPath,
    cwd: workDir,
    hook_event_name: "UserPromptSubmit",
    prompt,
  };
}

describe("hook end-to-end (synthetic transcript only)", () => {
  test("non-command prompts pass through untouched", async () => {
    const { stdout } = await runHook(
      hookInput(join(workDir, "none.jsonl"), "hello there"),
    );
    expect(JSON.parse(stdout)).toEqual({ suppressOutput: true });
  });

  test("invalid arguments produce a usage error", async () => {
    const { stdout } = await runHook(
      hookInput(join(workDir, "none.jsonl"), "/tiered-compact abc"),
    );
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["continue"]).toBe(false);
    expect(output["stopReason"]).toContain(
      "Usage: /tiered-compact [N]",
    );
  });

  test("namespaced command form is accepted", async () => {
    const { stdout } = await runHook(
      hookInput(
        join(workDir, "none.jsonl"),
        "/tiered-compact:tiered-compact xyz",
      ),
    );
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["stopReason"]).toContain("Usage: /tiered-compact");
  });

  test("all-scaffold transcript compacts end-to-end without a summarizer", async () => {
    const sessionDir = await mkdtemp(join(workDir, "scaffold-"));
    const rows: TranscriptRow[] = chainRows([
      [
        userRow("Write the directive, then we compact", null),
        assistantRow(
          [textBlock(`Directive written. ${SCAFFOLD_MARKER}`)],
          null,
        ),
      ],
    ]);
    const transcriptPath = join(sessionDir, "scaffold-session.jsonl");
    await writeFile(
      transcriptPath,
      `${rows.map(row => JSON.stringify(row)).join("\n")}\n`,
    );

    const { stdout } = await runHook(
      hookInput(transcriptPath, "/tiered-compact"),
    );
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["continue"]).toBe(false);
    // Inventory, not verdict — the counts must be present and the cold-door
    // instruction must name a COLD resume.
    expect(output["stopReason"]).toContain("Tiered Compact wrote ");
    expect(output["stopReason"]).toContain("summaries consumed: ");
    expect(output["stopReason"]).toContain("eras collapsed: 0");
    expect(output["stopReason"]).toContain("claude --resume ");

    // Locate and inspect the destination transcript.
    const stopReason = String(output["stopReason"]);
    const destinationId = stopReason.split("claude --resume ")[1]!.trim().split("\n")[0]!.trim();
    const destinationPath = join(sessionDir, `${destinationId}.jsonl`);
    const destination = await readFile(destinationPath, "utf8");

    expect(destination).not.toContain(SCAFFOLD_MARKER);
    expect(destination).toContain(
      "A scaffolding turn was removed here by tiered-compact.",
    );
    expect(destination).toContain("Write the directive, then we compact");
    expect(destination).toContain("post-compaction-notice");

    // Original transcript untouched (still has the marker).
    const original = await readFile(transcriptPath, "utf8");
    expect(original).toContain(SCAFFOLD_MARKER);

    // Omission cache went to the overridden directory, not ~/.claude.
    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles).toEqual([`${destinationId}.json`]);
  });

  test("nothing to compact is a clean no-op skip", async () => {
    const sessionDir = await mkdtemp(join(workDir, "noop-"));
    const rows: TranscriptRow[] = chainRows([
      [
        userRow("Just one turn", null),
        assistantRow([textBlock("Done.")], null),
      ],
    ]);
    const transcriptPath = join(sessionDir, "noop-session.jsonl");
    await writeFile(
      transcriptPath,
      `${rows.map(row => JSON.stringify(row)).join("\n")}\n`,
    );

    const { stdout } = await runHook(
      hookInput(transcriptPath, "/tiered-compact 5"),
    );
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["continue"]).toBe(false);
    expect(output["stopReason"]).toContain("Tiered Compact skipped");

    // No stray destination transcript left behind.
    const files = await readdir(sessionDir);
    expect(files).toEqual(["noop-session.jsonl"]);
  });
});

describe("/whoami (2026-08-30)", () => {
  test("reports identity as an inventory, with ancestors", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "whoami-"));
    const transcriptPath = join(sessionDir, "11111111-2222-4333-8444-555555555555.jsonl");
    const rows = [
      { type: "user", uuid: "a1", parentUuid: null, sessionId: "99999999-8888-4777-8666-555555555555", timestamp: "2026-08-30T10:00:00.000Z", message: { role: "user", content: "carried from ancestor" } },
      { type: "assistant", uuid: "a2", parentUuid: "a1", sessionId: "11111111-2222-4333-8444-555555555555", timestamp: "2026-08-30T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 100, cache_read_input_tokens: 41900, cache_creation_input_tokens: 0 } } },
    ];
    await Bun.write(transcriptPath, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const { stdout } = await runHook({
      session_id: "11111111-2222-4333-8444-555555555555",
      transcript_path: transcriptPath,
      cwd: null,
      hook_event_name: "UserPromptSubmit",
      prompt: "/whoami",
    });
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["continue"]).toBe(false);
    const report = String(output["stopReason"]);
    expect(report).toContain("You are session 11111111-2222-4333-8444-555555555555");
    expect(report).toContain("2 rows");
    expect(report).toContain("42,000 tokens");
    expect(report).toContain("ancestor session ids in this file: 99999999");
  });

  test("NEGATIVE CONTROL: /whoami-ish prose does not intercept", async () => {
    // "tell me about /whoami" as a prompt must NOT be swallowed by the hook —
    // parse must miss, output must be suppressOutput, the model must get it.
    const sessionDir = await mkdtemp(join(tmpdir(), "whoami-neg-"));
    const transcriptPath = join(sessionDir, "11111111-2222-4333-8444-555555555556.jsonl");
    await Bun.write(transcriptPath, "");
    const { stdout } = await runHook({
      session_id: "11111111-2222-4333-8444-555555555556",
      transcript_path: transcriptPath,
      cwd: null,
      hook_event_name: "UserPromptSubmit",
      prompt: "what does /whoami do in this house?",
    });
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output["suppressOutput"]).toBe(true);
    expect(output["continue"]).toBeUndefined();
  });
});
