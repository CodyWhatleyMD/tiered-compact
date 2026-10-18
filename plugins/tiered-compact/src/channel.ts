import { isRecord, type TranscriptRow } from "./transcript";

/**
 * Not everything in the person's channel is the person's words. A note a side
 * agent offered and the person forwarded arrives stamped exactly like typing
 * (promptSource "typed", origin.kind "human" — measured 2026-10-18), and a slash
 * command's output carries no stamp at all, which tiered-compact reads as human. So
 * these are told apart by what they say, not by how they're stamped.
 *
 * Everything else is "typed" and protected: tiered-compact never turns it into a
 * pointer, even when an authoring file lists it: tiered-compact leans toward keeping
 * the person's words, and leaves the rest to the judgment of the session that
 * authors the crossing.
 */
export type ChannelKind = "typed" | "side-agent note" | "command output" | "harness notice";

export function rowText(row: TranscriptRow): string {
  const content = isRecord(row.message) ? row.message["content"] : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => isRecord(block) && block["type"] === "text" && typeof block["text"] === "string")
    .map(block => (block as { text: string }).text)
    .join("\n");
}

export function channelKind(row: TranscriptRow): ChannelKind {
  const text = rowText(row).trimStart();
  if (text.startsWith("Here is a note offered by a side agent")) return "side-agent note";
  if (text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-caveat>")) return "command output";
  if (text.startsWith("Your response above was stopped by a safety classifier")) return "harness notice";
  return "typed";
}

/** A short plain opening for listings and pointer lines. */
export function openingOf(row: TranscriptRow, length = 80): string {
  const plain = rowText(row)
    .replace(/<[^>]+>/g, " ")
    .replace(/^Here is a note offered by a side agent:\s*/, "")
    .replace(/[>*#\s]+/g, " ")
    .trim();
  return plain.length > length ? `${plain.slice(0, length - 1)}…` : plain;
}

const SOURCE: Record<Exclude<ChannelKind, "typed">, string> = {
  "side-agent note": "a side agent's note the person forwarded",
  "command output": "a slash command's output",
  "harness notice": "a notice from the harness",
};

/** What a pointered row says in place of its text; the original stays in the era's full rows. */
export function pointerLine(kind: Exclude<ChannelKind, "typed">, row: TranscriptRow, contentId: string): string {
  return `[${SOURCE[kind]}, ${rowText(row).length} chars, opening "${openingOf(row, 60)}"; `
    + `the original is in this era's full rows: read_omitted_content("${contentId}")]`;
}
