import {
  allocateOmission,
  inputOmissionNotice,
  outputOmissionNotice,
} from "./omission";
import { isRecord, type JsonRecord, type TranscriptRow } from "./transcript";

type OmissionCache = Parameters<typeof allocateOmission>[0];

export type PruneContext = ToolContext;

type ToolContext = {
  cache: OmissionCache;
  sessionId: string;
  completedToolUseIds: Set<string>;
  toolNamesById: Map<string, string>;
  /** Deep tier for inherited turns — both summarized eras and the prefix era
   * (turns carried over from PRIOR compactions): universal, aggressive,
   * compact notices. Measured 2026-08-10: mechanically-preserved tool I/O was
   * 59% of resident context (~246k tokens) because the lenient tier only
   * pruned a named tool list above 1024 chars and spent 200-300 chars per XML
   * notice. Deep mode prunes EVERY tool's I/O above DEEP_LIMIT chars with
   * one-line notices, keeping the Content ID so read_omitted_content still
   * retrieves the original. Prefix TEXT rows are never touched — the curated
   * layer (summaries, pinned verbatims, user words) stays byte-faithful
   * forever; only the tool I/O underneath it is archaeology. */
  deep?: boolean;
};

const DEFAULT_LIMIT = { words: 128, chars: 1024 };
const DEEP_LIMIT_CHARS = 200;
const AGENT_OUTPUT_LIMIT = { words: 512, chars: 4096 };
const DEFAULT_OUTPUT_DESCRIPTION =
  "Output omitted due to a compaction operation.";

export function pruneTranscriptRow(
  row: TranscriptRow,
  context: ToolContext,
): void {
  if (!isRecord(row.message)) {
    return;
  }

  const content = row.message["content"];
  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (block["type"] === "tool_use") {
      pruneToolInput(block, context);
    }

    if (block["type"] === "tool_result") {
      pruneToolOutput(block, context);
    }
  }
}

function pruneToolInput(block: JsonRecord, context: ToolContext): void {
  const toolName = typeof block["name"] === "string" ? block["name"] : null;
  const toolUseId = typeof block["id"] === "string" ? block["id"] : null;
  if (!toolName || !toolUseId) {
    return;
  }

  context.toolNamesById.set(toolUseId, toolName);
  if (!context.completedToolUseIds.has(toolUseId)) {
    return;
  }

  const input = block["input"];
  if (!isRecord(input) || toolName === "AskUserQuestion") {
    return;
  }

  if (context.deep) {
    deepPruneToolInput(block, input, toolName, context);
    return;
  }

  if (toolName === "Bash") {
    truncateBashCommand(input, context.cache, context.sessionId);
    return;
  }

  if (toolName === "Write") {
    omitField(
      input,
      "content",
      "File write contents omitted due to a compaction operation. If necessary, reread file to see current contents.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "Edit") {
    omitCombinedFields(
      input,
      "old_string",
      "new_string",
      "File edit old_string and new_string omitted due to compaction operation. If necessary, reread file to see current contents.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "NotebookEdit") {
    omitField(
      input,
      "new_source",
      "Notebook edit source omitted due to compaction operation. If necessary, reread notebook to see current contents.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "Agent") {
    omitField(
      input,
      "prompt",
      "Agent prompt omitted due to compaction operation.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "Workflow") {
    omitField(
      input,
      "script",
      "Workflow script omitted due to compaction operation.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "SendMessage") {
    omitField(
      input,
      "message",
      "Inter-agent message omitted due to compaction operation.",
      context.cache,
      context.sessionId,
    );
    return;
  }

  if (toolName === "ReportFindings") {
    omitField(
      input,
      "findings",
      "Report findings omitted due to compaction operation.",
      context.cache,
      context.sessionId,
    );
  }
}

/** The exact shapes of the notices this plugin emits: the lenient tier's XML
 * block and the deep tier's one-liner. Reuse a prior Content ID instead of
 * stacking a second hop of indirection — but only on an anchored match.
 *
 * The anchoring is the point. The earlier heuristic asked whether a text
 * CONTAINED exactly one `Content ID:`, which becomes a live hazard once the
 * prefix era is in scope: a stored tool result that merely QUOTES an ID — a
 * diff of this very file, a doc showing an example notice, a `git show` of the
 * commit that introduced one — would hand its neighbour's ID to a fresh
 * omission, and read_omitted_content would then return unrelated bytes.
 * Byte-exact retrieval is the contract, so reuse happens only when the text IS
 * a notice. When in doubt, allocate: a duplicate cache entry is free, a
 * silently misdirected one is not. */
const XML_NOTICE_PATTERN =
  /^<tool-(?:input|output)-omission-notice>[\s\S]*\nContent ID: ([\w-]+:omitted-\d+)\n<\/tool-(?:input|output)-omission-notice>$/;
const DEEP_NOTICE_PATTERN =
  /^\[[^[\]]*read_omitted_content\("([\w-]+:omitted-\d+)"\)\]$/;

/** The Content ID of an already-deep-pruned payload, or null. Its presence
 * means "leave this alone": re-pruning would restate the notice with the
 * notice's own length and produce a notice-of-a-notice. */
function deepNoticeId(text: string): string | null {
  return DEEP_NOTICE_PATTERN.exec(text.trim())?.[1] ?? null;
}

function noticeId(text: string): string | null {
  const trimmed = text.trim();
  return (
    XML_NOTICE_PATTERN.exec(trimmed)?.[1]
    ?? DEEP_NOTICE_PATTERN.exec(trimmed)?.[1]
    ?? null
  );
}

/** A tool_result's payload as a single string, when it is one. Richer content
 * (multi-block, images) gets a fresh omission rather than a guessed reuse. */
function soleText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content) && content.length === 1) {
    const block = content[0];
    if (
      isRecord(block)
      && block["type"] === "text"
      && typeof block["text"] === "string"
    ) {
      return block["text"];
    }
  }

  return null;
}

/** Reuse a prior Content ID only when exactly one of the input's OWN fields is
 * a whole omission notice — the lenient tier's `<field>_omission_notice`
 * sidecar. Structural, so a quoted ID buried inside a `command` or `content`
 * field can never masquerade as one. */
function reusableInputId(input: JsonRecord): string | null {
  const ids = new Set<string>();
  for (const value of Object.values(input)) {
    if (typeof value !== "string") {
      continue;
    }
    const id = noticeId(value);
    if (id) {
      ids.add(id);
    }
  }
  return ids.size === 1 ? (ids.values().next().value ?? null) : null;
}

function deepPruneToolInput(
  block: JsonRecord,
  input: JsonRecord,
  toolName: string,
  context: ToolContext,
): void {
  // Idempotence, explicit. Successive compactions re-walk the prefix era, so
  // an already-compacted input must come out byte-identical. The 200-char
  // threshold covers this for most notices, but a kept 120-char file_path can
  // push one back over the line — so key off the marker, not the length.
  const compacted = input["_compacted"];
  if (typeof compacted === "string" && deepNoticeId(compacted)) {
    return;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= DEEP_LIMIT_CHARS) {
    return;
  }

  const contentId =
    reusableInputId(input)
    ?? allocateOmission(context.cache, context.sessionId, serialized);
  // Keep cheap identifying scalars (paths, symbols) so the call stays legible
  // without re-reading the omission; drop everything heavy.
  const kept: JsonRecord = {};
  for (const key of ["file_path", "path", "url", "description", "skill", "to"]) {
    const v = input[key];
    if (typeof v === "string" && v.length <= 120) {
      kept[key] = v;
    }
  }
  block["input"] = {
    ...kept,
    _compacted: `[${toolName} input omitted: ${serialized.length}ch — read_omitted_content("${contentId}")]`,
  };
}

function pruneToolOutput(block: JsonRecord, context: ToolContext): void {
  if (block["is_error"] === true) {
    return;
  }

  const toolUseId =
    typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : null;
  const toolName = toolUseId ? context.toolNamesById.get(toolUseId) : null;
  if (!toolName || toolName === "AskUserQuestion") {
    return;
  }

  if (context.deep) {
    const sole = soleText(block["content"]);
    // Idempotence: an existing one-line notice is left exactly as it is.
    if (sole !== null && deepNoticeId(sole)) {
      return;
    }
    const content = stringifyContent(block["content"]);
    if (content.length <= DEEP_LIMIT_CHARS) {
      return;
    }
    const contentId =
      (sole === null ? null : noticeId(sole))
      ?? allocateOmission(context.cache, context.sessionId, content);
    block["content"] =
      `[${toolName} output omitted: ${content.length}ch — read_omitted_content("${contentId}")]`;
    return;
  }

  if (toolName === "Skill") {
    block["content"] =
      "Skill output omitted due to compaction operation. If necessary, recall the skill.";
    return;
  }

  const content = stringifyContent(block["content"]);
  if (!content) {
    return;
  }

  if (toolName === "Read") {
    const contentId = allocateOmission(
      context.cache,
      context.sessionId,
      content,
    );
    block["content"] = outputOmissionNotice(
      "Stale read contents omitted due to compaction operation. If necessary, reread to see current contents.",
      content.length,
      contentId,
    );
    return;
  }

  if (toolName === "NotebookEdit") {
    const contentId = allocateOmission(
      context.cache,
      context.sessionId,
      content,
    );
    block["content"] = outputOmissionNotice(
      "Notebook edit output omitted due to compaction operation. If necessary, reread notebook to see current contents.",
      content.length,
      contentId,
    );
    return;
  }

  const limit =
    toolName === "Agent" || toolName === "TaskOutput"
      ? AGENT_OUTPUT_LIMIT
      : DEFAULT_LIMIT;
  if (!exceeds(content, limit)) {
    return;
  }

  const contentId = allocateOmission(context.cache, context.sessionId, content);
  block["content"] = outputOmissionNotice(
    DEFAULT_OUTPUT_DESCRIPTION,
    content.length,
    contentId,
  );
}

function omitField(
  input: JsonRecord,
  field: string,
  description: string,
  cache: OmissionCache,
  sessionId: string,
): void {
  const content = stringifyContent(input[field]);
  if (!content || !exceeds(content, DEFAULT_LIMIT)) {
    return;
  }

  const contentId = allocateOmission(cache, sessionId, content);
  input[field] = "[Omitted]";
  input[`${field}_omission_notice`] = inputOmissionNotice(
    description,
    content.length,
    contentId,
  );
}

function omitCombinedFields(
  input: JsonRecord,
  firstField: string,
  secondField: string,
  description: string,
  cache: OmissionCache,
  sessionId: string,
): void {
  const first = stringifyContent(input[firstField]);
  const second = stringifyContent(input[secondField]);
  const combined = `${first}\n${second}`;
  if (!exceeds(combined, DEFAULT_LIMIT)) {
    return;
  }

  const contentId = allocateOmission(cache, sessionId, combined);
  input[firstField] = "[Omitted]";
  input[secondField] = "[Omitted]";
  input[`${firstField}_${secondField}_omission_notice`] = inputOmissionNotice(
    description,
    combined.length,
    contentId,
  );
}

function truncateBashCommand(
  input: JsonRecord,
  cache: OmissionCache,
  sessionId: string,
): void {
  const command = stringifyContent(input["command"]);
  if (command.length <= 1024) {
    return;
  }

  const contentId = allocateOmission(cache, sessionId, command);
  input["command"] = `${command.slice(0, 512)}\n[REST OF COMMAND TRUNCATED]`;
  input["command_omission_notice"] = inputOmissionNotice(
    "Bash command truncated due to compaction operation.",
    command.length,
    contentId,
  );
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (content === undefined || content === null) {
    return "";
  }

  return JSON.stringify(content);
}

function exceeds(
  text: string,
  limit: { words: number; chars: number },
): boolean {
  return wordCount(text) > limit.words || text.length > limit.chars;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
