export type UserPromptSubmitHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string | null;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
};

const commandHeadPattern = /^\/(?:tiered-compact:)?tiered-compact\b([\s\S]*)$/;

// Slash-command dispatch (picking the command from the menu rather than
// typing it) delivers the prompt as command XML, not the raw string:
//   <command-message>tiered-compact:tiered-compact</command-message>
//   <command-name>/tiered-compact:tiered-compact</command-name>
//   <command-args>--eras</command-args>
// Observed live 2026-08-27: the raw-form regex missed it, the hook never
// fired, the fallback skill shim loaded instead, and an authored eras file
// sat unconsumed while the session sat at 950k. Both forms parse now.
//
// ANCHORED, and the <command-message> prefix is REQUIRED. The unanchored
// version searched anywhere in the prompt, so merely quoting these tags in a
// sentence — asking why the hook did not fire, pasting a transcript excerpt —
// parsed as a live command and dispatched a real compaction with real workers.
// Checked against every dispatch on this machine: 807/807 real ones begin with
// <command-message>, and the only prompts that carried the tags without it were
// two that discussed them. Anchoring costs nothing and closes the hole under
// both multiline and single-line regex semantics.
const commandXmlPattern =
  /^<command-message>[^<]*<\/command-message>\s*<command-name>\/(?:tiered-compact:)?tiered-compact<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;

const USAGE =
  "Usage: /tiered-compact [N] [--fork [K] | --subagent [K]] [--model <id>] "
  + "[--eras [K]] (worker K: 1-16; --model only with --subagent; --eras K = "
  + "collapse prefix eras older than the K newest, default 1)";

export type Worker =
  | { type: "inline" }
  /** count null = bare flag, the model chooses K. */
  | { type: "fork"; count: number | null }
  | { type: "subagent"; count: number | null; model: string | null };

export type TieredCompactCommand = {
  /**
   * Recent assistant turns to keep whole.
   *
   * null means the user gave no N at all — which is NOT 0. `--eras` alone used
   * to parse to 0, and createPlan reads `keepTurns <= 0` as "summarize every
   * turn", so asking for a deep-history pass silently compacted the entire live
   * working thread. An omitted N now preserves the live conversation and collapses eras
   * only; an EXPLICIT 0 still means compact everything.
   */
  keepTurns: number | null;
  worker: Worker;
  /** null = no era collapse; K = keep the K newest prefix eras uncollapsed. */
  eras: number | null;
};

export function parseHookInput(rawInput: string): UserPromptSubmitHookInput {
  const input: unknown = JSON.parse(rawInput);
  if (!isRecord(input)) {
    throw new Error("Hook input must be a JSON object.");
  }

  if (
    typeof input.session_id !== "string"
    || typeof input.transcript_path !== "string"
    || input.hook_event_name !== "UserPromptSubmit"
    || typeof input.prompt !== "string"
  ) {
    throw new Error("Hook input is missing required UserPromptSubmit fields.");
  }

  return {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: typeof input.cwd === "string" ? input.cwd : null,
    hook_event_name: input.hook_event_name,
    prompt: input.prompt,
  };
}

export function parseTieredCompactCommand(
  prompt: string,
): TieredCompactCommand | null {
  let effectivePrompt = prompt.trim();
  const xml = commandXmlPattern.exec(effectivePrompt);
  if (xml !== null) {
    effectivePrompt = `/tiered-compact ${(xml[1] ?? "").trim()}`.trim();
  }
  const head = effectivePrompt.match(commandHeadPattern);
  if (!head) {
    return null;
  }

  const tokens = (head[1] ?? "").trim().split(/\s+/).filter(Boolean);
  let keepTurns: number | null = null;
  let fork: number | null | undefined;
  let subagent: number | null | undefined;
  let model: string | null = null;
  let eras: number | null = null;

  let index = 0;
  if (index < tokens.length && /^\d+$/.test(tokens[index]!)) {
    keepTurns = Number(tokens[index]);
    index += 1;
  }
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--fork" || token === "--subagent") {
      const next = tokens[index + 1];
      let count: number | null = null;
      if (next !== undefined && /^\d+$/.test(next)) {
        count = Number(next);
        index += 1;
      }
      if (count !== null && (count < 1 || count > 16)) {
        throw new Error(USAGE);
      }
      if (token === "--fork") {
        fork = count;
      } else {
        subagent = count;
      }
    } else if (token === "--eras") {
      const next = tokens[index + 1];
      eras = 1;
      if (next !== undefined && /^\d+$/.test(next)) {
        eras = Number(next);
        index += 1;
      }
      if (eras < 1) {
        throw new Error(USAGE);
      }
    } else if (token === "--model") {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(USAGE);
      }
      model = next;
      index += 1;
    } else {
      throw new Error(USAGE);
    }
    index += 1;
  }

  if (fork !== undefined && subagent !== undefined) {
    throw new Error(USAGE);
  }
  if (model !== null && subagent === undefined) {
    throw new Error(
      "--model only applies to --subagent workers (forks always inherit the parent model; inline is the live instance).",
    );
  }

  const worker: Worker =
    fork !== undefined
      ? { type: "fork", count: fork }
      : subagent !== undefined
        ? { type: "subagent", count: subagent, model }
        : { type: "inline" };
  return { keepTurns, worker, eras };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
