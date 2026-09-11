/**
 * Turn-content extractor for --subagent workers (blank agents that inherit
 * no context and must read their assigned turns from disk).
 *
 *   bun src/slice.ts <transcriptPath> <turnKey> [<turnKey> ...]
 *
 * Prints a readable rendering of each requested turn (keyed by first-row
 * uuid, same keys as the orchestration payload): the user prompt, assistant
 * text, and truncated tool activity — enough substance to summarize from.
 * Thinking blocks are omitted. Read-only.
 */
import { turnKey } from "./summaries";
import {
  buildAssistantTurns,
  isRecord,
  readActiveTranscriptRows,
  type TranscriptRow,
} from "./transcript";

// Overridable because the authoring guidance tells workers to raise it when a
// turn's narrative is being cut mid-sentence — a summary written from a
// truncated view of its own turn is the failure this must not cause. Bad
// values fall back rather than producing NaN and slicing everything to nothing.
const DEFAULT_MAX_BLOCK_CHARS = 1500;
const envMaxBlockChars = Number(process.env["MAX_BLOCK_CHARS"]);
const MAX_BLOCK_CHARS = Number.isFinite(envMaxBlockChars) && envMaxBlockChars > 0
  ? envMaxBlockChars
  : DEFAULT_MAX_BLOCK_CHARS;

async function main(): Promise<void> {
  const [transcriptPath, ...keys] = process.argv.slice(2);
  if (!transcriptPath || keys.length === 0) {
    console.error("Usage: bun src/slice.ts <transcriptPath> <turnKey> [...]");
    process.exit(2);
  }

  const rows = await readActiveTranscriptRows(transcriptPath);
  const turns = new Map(
    buildAssistantTurns(rows).map(turn => [turnKey(turn), turn] as const),
  );

  const missing = keys.filter(key => !turns.has(key));
  if (missing.length > 0) {
    console.error(`Turn key(s) not found: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const key of keys) {
    const turn = turns.get(key)!;
    console.log(`=== turn ${key} (${turn.rows.length} rows) ===`);
    for (const row of turn.rows) {
      renderRow(row, turn.userRows.includes(row));
    }
    console.log("");
  }
}

function renderRow(row: TranscriptRow, isUserRow: boolean): void {
  if (!isRecord(row.message)) {
    return;
  }
  const role = isUserRow ? "user" : (row.type ?? "row");
  const content = row.message["content"];

  if (typeof content === "string") {
    console.log(`[${role}] ${truncate(content)}`);
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    switch (block["type"]) {
      case "text":
        console.log(`[${role}] ${truncate(block["text"])}`);
        break;
      case "tool_use":
        console.log(
          `[tool_use ${String(block["name"] ?? "?")}] ${truncate(
            JSON.stringify(block["input"] ?? {}),
            400,
          )}`,
        );
        break;
      case "tool_result": {
        const body = block["content"];
        const text = Array.isArray(body)
          ? body
              .map(part =>
                isRecord(part) && typeof part["text"] === "string"
                  ? part["text"]
                  : "",
              )
              .join("\n")
          : typeof body === "string"
            ? body
            : "";
        console.log(
          `[tool_result${block["is_error"] === true ? " ERROR" : ""}] ${truncate(text)}`,
        );
        break;
      }
      default:
        break; // thinking and other block types are omitted
    }
  }
}

function truncate(value: unknown, limit: number = MAX_BLOCK_CHARS): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > limit
    ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]`
    : value;
}

await main();
