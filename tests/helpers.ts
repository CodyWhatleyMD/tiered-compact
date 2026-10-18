import { randomUUID } from "node:crypto";
import type {
  JsonRecord,
  TranscriptRow,
  Turn,
} from "../plugins/tiered-compact/src/transcript";

let clock = 0;

function nextTimestamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
}

export function userRow(
  text: string,
  parentUuid: string | null,
): TranscriptRow {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    sessionId: "source-session",
    timestamp: nextTimestamp(),
    message: { role: "user", content: text },
  };
}

export function assistantRow(
  content: JsonRecord[],
  parentUuid: string | null,
): TranscriptRow {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid,
    sessionId: "source-session",
    timestamp: nextTimestamp(),
    message: {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content,
    },
  };
}

export function textBlock(text: string): JsonRecord {
  return { type: "text", text };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: JsonRecord = { command: "echo hi" },
): JsonRecord {
  return { type: "tool_use", id, name, input };
}

export function toolResultRow(
  toolUseId: string,
  output: string,
  parentUuid: string | null,
): TranscriptRow {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid,
    sessionId: "source-session",
    timestamp: nextTimestamp(),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: output },
      ],
    },
  };
}

/** Build a simple text-only turn: one user row, one assistant text row. */
export function makeTurn(userText: string, assistantText: string): Turn {
  const user = userRow(userText, null);
  const assistant = assistantRow([textBlock(assistantText)], user.uuid);
  return { userRows: [user], rows: [user, assistant] };
}

/** Flatten turns into a sequential row list with a valid parentUuid chain. */
export function chainRows(rowGroups: TranscriptRow[][]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let parentUuid: string | null = null;
  for (const group of rowGroups) {
    for (const row of group) {
      row.parentUuid = parentUuid;
      rows.push(row);
      parentUuid = row.uuid;
    }
  }
  return rows;
}

export function rowText(row: TranscriptRow): string {
  return JSON.stringify(row.message ?? {});
}
