import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pruneTranscriptRow } from "../plugins/tiered-compact/src/prune";
import type { TranscriptRow } from "../plugins/tiered-compact/src/transcript";

type Cache = { version: 1; nextId: number; entries: Record<string, { content: string }> };

function cache(): Cache {
  return { version: 1, nextId: 1, entries: {} };
}

function toolUseRow(name: string, id: string, input: Record<string, unknown>): TranscriptRow {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: "source-session",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  } as TranscriptRow;
}

function toolResultRow(toolUseId: string, content: unknown): TranscriptRow {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: "source-session",
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  } as TranscriptRow;
}

function context(c: Cache, ids: string[], names: Record<string, string>, deep: boolean) {
  return {
    cache: c,
    sessionId: "source-session-abcdef",
    completedToolUseIds: new Set(ids),
    toolNamesById: new Map(Object.entries(names)),
    deep,
  };
}

function firstBlock(row: TranscriptRow): Record<string, unknown> {
  const content = (row.message as Record<string, unknown>)["content"] as Record<string, unknown>[];
  return content[0] as Record<string, unknown>;
}

describe("deep prune tier (summarized eras)", () => {
  test("omits ANY tool's large input with a one-line notice, keeping cheap scalars", () => {
    const c = cache();
    const big = "x".repeat(2000);
    const row = toolUseRow("mcp__example__do_thing", "t1", {
      content: big,
      file_path: "/home/user/notes.md",
    });
    pruneTranscriptRow(row, context(c, ["t1"], {}, true));

    const input = firstBlock(row)["input"] as Record<string, unknown>;
    expect(input["content"]).toBeUndefined();
    expect(input["file_path"]).toBe("/home/user/notes.md");
    const notice = String(input["_compacted"]);
    expect(notice).toContain("input omitted");
    expect(notice).toContain("read_omitted_content");
    const id = notice.match(/read_omitted_content\("([^"]+)"\)/)?.[1];
    expect(id).toBeTruthy();
    expect(c.entries[id as string]?.content).toContain(big.slice(0, 50));
  });

  test("leaves small inputs untouched", () => {
    const c = cache();
    const row = toolUseRow("Read", "t2", { file_path: "/tmp/a.txt" });
    pruneTranscriptRow(row, context(c, ["t2"], {}, true));
    const input = firstBlock(row)["input"] as Record<string, unknown>;
    expect(input["file_path"]).toBe("/tmp/a.txt");
    expect(input["_compacted"]).toBeUndefined();
    expect(Object.keys(c.entries)).toHaveLength(0);
  });

  test("omits large outputs with a retrievable one-liner", () => {
    const c = cache();
    const big = "result ".repeat(400);
    const row = toolResultRow("t3", big);
    pruneTranscriptRow(row, context(c, ["t3"], { t3: "Bash" }, true));
    const content = String(firstBlock(row)["content"]);
    expect(content).toContain("Bash output omitted");
    const id = content.match(/read_omitted_content\("([^"]+)"\)/)?.[1];
    expect(c.entries[id as string]?.content).toContain("result result");
  });

  test("reuses a prior omission's Content ID instead of stacking hops", () => {
    const c = cache();
    const priorNotice = `<tool-output-omission-notice>
Output omitted due to a compaction operation. If the exact I/O of the tool call
needs to be retrieved and functionality cannot be replicated via a new tool
call, call the read_omitted_content tool with the appropriate Content ID.

Omitted Length: 9999 characters
Content ID: 9315b6171ea0:omitted-042
</tool-output-omission-notice>`;
    const row = toolResultRow("t4", priorNotice);
    pruneTranscriptRow(row, context(c, ["t4"], { t4: "Bash" }, true));
    const content = String(firstBlock(row)["content"]);
    expect(content).toContain('read_omitted_content("9315b6171ea0:omitted-042")');
    expect(Object.keys(c.entries)).toHaveLength(0); // no new allocation
  });

  test("never touches AskUserQuestion", () => {
    const c = cache();
    const options = { questions: [{ question: "?".repeat(1500) }] };
    const row = toolUseRow("AskUserQuestion", "t5", options);
    pruneTranscriptRow(row, context(c, ["t5"], {}, true));
    const input = firstBlock(row)["input"] as Record<string, unknown>;
    expect(input["questions"]).toBeDefined();
    expect(input["_compacted"]).toBeUndefined();
  });

  test("a deep notice is never re-pruned into a notice-of-a-notice", () => {
    // Successive compactions re-walk the prefix era, so every already-pruned
    // row is pruned AGAIN, and again, forever. The second pass must be a
    // no-op. The long file_path is the trap: it is a kept scalar, so the
    // re-serialized input clears 200 chars on its own and the length threshold
    // alone would NOT save this row.
    const c = cache();
    // Must sit in the 100..120 window: over 100 so the re-serialized input
    // clears the deep threshold on its own, and <= 120 so pruneToolInput still
    // KEEPS it as an identifying scalar. Outside that window the trap does not
    // exist and this test silently stops testing anything. (A path shortened
    // past 120 by a search-and-replace is exactly how that happened once.)
    const longPath = `/tmp/${"nested-dir/".repeat(9)}f.ts`;
    expect(longPath.length).toBeGreaterThan(100);
    expect(longPath.length).toBeLessThanOrEqual(120);
    const row = toolUseRow("Bash", "t7", {
      command: "q".repeat(2000),
      file_path: longPath,
    });
    const resultRow = toolResultRow("t7", "w".repeat(2000));

    pruneTranscriptRow(row, context(c, ["t7"], { t7: "Bash" }, true));
    pruneTranscriptRow(resultRow, context(c, ["t7"], { t7: "Bash" }, true));
    const afterFirst = JSON.stringify(row);
    const afterFirstResult = JSON.stringify(resultRow);
    const idsAfterFirst = Object.keys(c.entries).length;
    expect(idsAfterFirst).toBe(2);
    expect(
      JSON.stringify(firstBlock(row)["input"]).length,
    ).toBeGreaterThan(200);

    pruneTranscriptRow(row, context(c, ["t7"], { t7: "Bash" }, true));
    pruneTranscriptRow(resultRow, context(c, ["t7"], { t7: "Bash" }, true));
    expect(JSON.stringify(row)).toBe(afterFirst);
    expect(JSON.stringify(resultRow)).toBe(afterFirstResult);
    expect(Object.keys(c.entries)).toHaveLength(idsAfterFirst);
  });

  test("a QUOTED Content ID is not a reuse target", () => {
    // The hazard the prefix era introduces: stored tool output that merely
    // mentions a Content ID — a diff of prune.ts, a doc showing an example
    // notice, a `git show` of the commit that added one. Reusing that ID would
    // point retrieval at somebody else's bytes, and byte-exact retrieval is
    // the whole contract.
    const c = cache();
    const quoting = `diff --git a/prune.ts b/prune.ts
${"+".repeat(20)} the notice we emit looks like this:
+  Content ID: 9315b6171ea0:omitted-042
${"context line ".repeat(30)}`;
    const row = toolResultRow("t8", quoting);
    pruneTranscriptRow(row, context(c, ["t8"], { t8: "Bash" }, true));

    const content = String(firstBlock(row)["content"]);
    const id = content.match(/read_omitted_content\("([^"]+)"\)/)?.[1];
    expect(id).not.toBe("9315b6171ea0:omitted-042");
    expect(Object.keys(c.entries)).toHaveLength(1);
    // Byte-exact, including the quoted ID it was never allowed to borrow.
    expect(c.entries[id as string]?.content).toBe(quoting);
  });

  test("reuse survives the lenient tier's sidecar-field shape", () => {
    // What a prefix row pruned by an EARLIER generation actually looks like:
    // the payload replaced by "[Omitted]", the ID parked in a sibling field.
    const c = cache();
    const row = toolUseRow("Write", "t9", {
      file_path: "/tmp/a.ts",
      content: "[Omitted]",
      content_omission_notice: `<tool-input-omission-notice>
File write contents omitted due to a compaction operation.

Omitted Length: 40000 characters
Content ID: 9315b6171ea0:omitted-007
</tool-input-omission-notice>`,
    });
    pruneTranscriptRow(row, context(c, ["t9"], {}, true));

    const input = firstBlock(row)["input"] as Record<string, unknown>;
    expect(String(input["_compacted"])).toContain(
      'read_omitted_content("9315b6171ea0:omitted-007")',
    );
    expect(Object.keys(c.entries)).toHaveLength(0); // no new allocation
  });

  test("lenient tier still ignores unnamed tools (regression)", () => {
    const c = cache();
    const big = "y".repeat(3000);
    const row = toolUseRow("mcp__some__tool", "t6", { payload: big });
    pruneTranscriptRow(row, context(c, ["t6"], {}, false));
    const input = firstBlock(row)["input"] as Record<string, unknown>;
    expect(input["payload"]).toBe(big);
  });
});
