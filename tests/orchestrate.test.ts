import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assistantRow, chainRows, textBlock, userRow } from "./helpers";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";

const SRC = resolve(import.meta.dir, "../plugins/tiered-compact/src");

let workDir: string;
let cacheDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tiered-orch-"));
  cacheDir = await mkdtemp(join(tmpdir(), "tiered-orch-cache-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

function syntheticRows(turnCount: number): TranscriptRow[] {
  const groups: TranscriptRow[][] = [];
  for (let index = 0; index < turnCount; index++) {
    const user = userRow(`user prompt ${index}`, null);
    const assistant = assistantRow(
      [textBlock(`assistant reply ${index} with enough words to summarize`)],
      user.uuid,
    );
    groups.push([user, assistant]);
  }
  return chainRows(groups);
}

async function writeTranscript(name: string, rows: TranscriptRow[]): Promise<string> {
  const path = join(workDir, name);
  await Bun.write(path, rows.map(row => JSON.stringify(row)).join("\n"));
  return path;
}

async function runHook(
  transcriptPath: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", join(SRC, "hook.ts")], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: "orch-test-session",
        transcript_path: transcriptPath,
        cwd: workDir,
        hook_event_name: "UserPromptSubmit",
        prompt,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TIERED_COMPACT_CACHE_DIR: cacheDir },
  });
  return JSON.parse(await new Response(proc.stdout).text()) as Record<
    string,
    unknown
  >;
}

function payloadOf(output: Record<string, unknown>): string {
  const hookSpecific = output["hookSpecificOutput"] as
    | { additionalContext?: string }
    | undefined;
  expect(hookSpecific?.additionalContext).toBeString();
  return hookSpecific!.additionalContext!;
}

describe("orchestration payloads (no summaries file present)", () => {
  test("plain command injects inline instructions", async () => {
    const transcript = await writeTranscript("inline.jsonl", syntheticRows(12));
    const payload = payloadOf(await runHook(transcript, "/tiered-compact 4"));
    expect(payload).toContain("mode=inline");
    expect(payload).toContain("tiered-summaries.part-1.json");
    expect(payload).toContain("turnsNeedingSummaries=8");
    expect(payload).toContain("boundaryKey=");
  });

  test("--fork K injects K partitions covering every turn once", async () => {
    const transcript = await writeTranscript("fork.jsonl", syntheticRows(12));
    const payload = payloadOf(
      await runHook(transcript, "/tiered-compact 4 --fork 3"),
    );
    expect(payload).toContain("mode=fork");
    expect(payload).toContain("CLAUDE_CODE_FORK_SUBAGENT");
    const partitions = JSON.parse(
      payload.slice(payload.indexOf("partitions: ") + "partitions: ".length),
    ) as Array<{ file: string; turns: Array<{ key: string }> }>;
    expect(partitions).toHaveLength(3);
    const keys = partitions.flatMap(part => part.turns.map(turn => turn.key));
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
  });

  test("bare --fork defers the count to the model", async () => {
    const transcript = await writeTranscript("forkbare.jsonl", syntheticRows(12));
    const payload = payloadOf(
      await runHook(transcript, "/tiered-compact 4 --fork"),
    );
    expect(payload).toContain("you decide");
    expect(payload).toContain("partition these yourself");
  });

  test("--subagent carries slice.ts and the model override", async () => {
    const transcript = await writeTranscript("sub.jsonl", syntheticRows(12));
    const payload = payloadOf(
      await runHook(
        transcript,
        "/tiered-compact 4 --subagent 2 --model claude-haiku-4-5-20251001",
      ),
    );
    expect(payload).toContain("mode=subagent");
    expect(payload).toContain("slice.ts");
    expect(payload).toContain('model: "claude-haiku-4-5-20251001"');
    expect(payload).toContain("inherit NO context");
  });
});

describe("merge + assembly round trip", () => {
  test("partials merge, validate, and compact end-to-end", async () => {
    const transcript = await writeTranscript("round.jsonl", syntheticRows(12));
    const payload = payloadOf(
      await runHook(transcript, "/tiered-compact 4 --fork 2"),
    );
    const boundaryKey = /boundaryKey=([a-f0-9-]+|END)/.exec(payload)![1]!;
    const partitions = JSON.parse(
      payload.slice(payload.indexOf("partitions: ") + "partitions: ".length),
    ) as Array<{ file: string; turns: Array<{ key: string; seq: number }> }>;

    // Simulate the workers.
    for (const part of partitions) {
      const summaries = Object.fromEntries(
        part.turns.map(turn => [turn.key, `SENTINEL_${turn.seq} summary.`]),
      );
      await Bun.write(
        join(workDir, part.file),
        JSON.stringify({ summaries }),
      );
    }

    // Merge validates coverage against the boundary anchor.
    const merge = Bun.spawn(
      ["bun", join(SRC, "merge.ts"), transcript, boundaryKey],
      { stdout: "pipe", stderr: "pipe" },
    );
    const mergeOut = await new Response(merge.stdout).text();
    expect(await merge.exited).toBe(0);
    expect(JSON.parse(mergeOut)["turnsCovered"]).toBe(8);

    // Second invocation assembles now that the summaries file exists.
    const output = await runHook(transcript, "/tiered-compact 4");
    expect(output["continue"]).toBe(false);
    expect(output["stopReason"]).toContain("/resume");

    const produced = (await readdir(workDir)).filter(
      name => name.endsWith(".jsonl") && name !== "round.jsonl"
        && !name.startsWith("inline") && !name.startsWith("fork")
        && !name.startsWith("sub"),
    );
    expect(produced).toHaveLength(1);
    const compacted = await Bun.file(join(workDir, produced[0]!)).text();
    for (const part of partitions) {
      for (const turn of part.turns) {
        expect(compacted).toContain(`SENTINEL_${turn.seq} summary.`);
      }
    }
  });

  test("merge refuses incomplete partials and writes nothing", async () => {
    const transcript = await writeTranscript("gap.jsonl", syntheticRows(12));
    const payload = payloadOf(
      await runHook(transcript, "/tiered-compact 4 --fork 2"),
    );
    const boundaryKey = /boundaryKey=([a-f0-9-]+|END)/.exec(payload)![1]!;
    const partitions = JSON.parse(
      payload.slice(payload.indexOf("partitions: ") + "partitions: ".length),
    ) as Array<{ file: string; turns: Array<{ key: string; seq: number }> }>;

    // Only the first partial arrives.
    const first = partitions[0]!;
    await Bun.write(
      join(workDir, first.file),
      JSON.stringify({
        summaries: Object.fromEntries(
          first.turns.map(turn => [turn.key, "partial summary."]),
        ),
      }),
    );

    const merge = Bun.spawn(
      ["bun", join(SRC, "merge.ts"), transcript, boundaryKey],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(merge.stderr).text();
    expect(await merge.exited).toBe(1);
    expect(stderr).toContain("missing");
    expect(await Bun.file(join(workDir, "tiered-summaries.json")).exists()).toBe(
      false,
    );
    await rm(join(workDir, first.file), { force: true });
  });
});
