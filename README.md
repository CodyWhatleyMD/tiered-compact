# Riverbed Compact

Directed, lossless context compaction for Claude Code.

Claude Code's built-in auto-compaction summarizes your session with a separate, generic pass: you don't choose what survives, and what's dropped is gone. Riverbed Compact inverts that: **the instance that lived the session decides what its successor needs** — which exact phrases must survive verbatim, which threads keep their mechanism, which detours compress to a line.

What "lossless" means here, precisely, because the two mechanisms are different:

- **Your messages** are copied byte-for-byte into the compacted session. They are never summarized, rewritten, or dropped.
- **Bulky tool input and output** is moved into a retrievable cache and replaced by a Content ID, so it stays reachable from inside the new session via `read_omitted_content`.
- **Assistant prose and thinking on summarized turns are discarded**, replaced by the summary that was written to stand in for them. They are *not* in the cache. This is the whole point — the summary is the compression — but it means the authored summary is the only account of those turns that the new session can see. Write it accordingly.
- **The original session's conversation is never modified.** One `custom-title` row is appended to mark it `[UNCOMPACTED] …` in the session list; no existing row is touched, nothing is removed, and the full transcript stays on disk — so anything the compaction dropped is still recoverable from the source.

The name is the design: compaction changes the water; the riverbed — the words that carved the session — persists.

## How it works

`/riverbed-compact` is one self-guiding command with a simple state machine, keyed on whether a summaries file exists next to the session transcript:

1. **No summaries file** → the hook computes a compaction plan (which assistant turns need summaries, anchored by turn uuid) and injects mode-specific authoring instructions into the live model's context. The model writes the summaries — itself, or via workers it dispatches — as `riverbed-summaries.part-*.json` files.
2. `merge.ts` validates that the partials cover every planned turn (hard-failing on gaps), writes `riverbed-summaries.json`, and prints the exact follow-up command.
3. **Summaries file present** → the same command assembles the compacted session: user messages verbatim, old assistant turns replaced by the authored summaries, bulky tool I/O replaced by omission records retrievable via the `read_omitted_content` MCP tool. The original session is renamed `[UNCOMPACTED] …` and left intact. Sessions stay recompactable.

**Loading the compacted session — this part matters.** The command prints `claude --resume <new-session-id>` and tells you to **exit the client first**. An in-place `/resume` switches the transcript file but carries your current window along with it, so you get a compacted session and none of the savings. The reduction only exists on a cold load.

The plan is anchored to the uuid of the first preserved turn, so the orchestration turns spent authoring summaries can't drift the keep-boundary.

## Usage

```
/riverbed-compact N                     # inline (default): the live instance writes the summaries
/riverbed-compact N --fork [K]          # K forks — inherit the live context, work in parallel (experimental)
/riverbed-compact N --subagent [K] [--model <id>]   # K blank subagents — read their turns from disk, cheap
```

- `N` — recent assistant turns to keep whole (cover your current working thread).
- Bare `--fork` / `--subagent` — the model picks K (roughly 25–40 turns per worker, max 16).
- `--model` — only valid with `--subagent`: forks always inherit the parent model, and inline is the live instance.
- Turns whose text contains the literal token `[[riverbed:scaffold]]` are dropped to a one-line stub instead of summarized — use it so the compaction run itself costs nothing in the compacted output.

Choosing a mode: **inline** gives the highest fidelity on modest sessions (costs main-thread turns). **`--fork`** offloads authorship at full fidelity — each fork inherits the entire live conversation. **`--subagent`** is the budget mode — workers see only their extracted slice (via `slice.ts`), so the orchestrator's directive must spell out anything a summary has to preserve.

`/whoami` is also wired — as a hook matcher rather than a registered command, so **type it**; it will not appear in the slash-command menu. It prints an inventory of the current session — which transcript file is yours, its size and row count, and the chain of ancestor session ids if it has been compacted before. Useful when several sessions are open and you need to know which one you are in before doing something irreversible to it.

## Era collapse (`--eras`)

Compaction is not a one-time event on a long-lived session — you do it again, and again. Each pass leaves its summaries in the prefix, and every later pass copies that prefix forward untouched. After a few generations the prefix is most of the window, held at recent-turn density forever, and ordinary compaction has nothing left to work on: it reports `prefix=533, summarized=0` and buys you nothing.

`--eras` is the pass that reaches the prefix. An **era** is one prior generation's contribution — its run of summary-marked turns plus the plain turns that followed. Collapsing one:

- copies its **user rows whole, in order** (the human's words are never rewritten)
- writes the era's full original rows to the omission cache under a single era Content ID — demoted, never deleted, retrievable with `read_omitted_content`
- emits **one stub row**: diagnostic text that discriminates this era from the others, any pinned verbatims exact, plus span, turn count, and the Content ID

The stub is written by the live session rather than a cold worker, via `riverbed-eras.json`. Older eras compress hard while your current arc keeps its texture.

```
/riverbed-compact --eras [K]        # collapse eras only; the live bed is untouched
/riverbed-compact 20 --eras [K]     # collapse eras AND compact down to 20 kept turns
```

`K` defaults to 1 and means *keep the K newest eras uncollapsed*.

**Note on `N`:** omitting `N` is not the same as `N=0`. With no `N`, the live working thread is preserved and only eras are collapsed. An explicit `/riverbed-compact 0` means *summarize every turn*, which is a thing you can ask for but rarely want by accident.

## Identity and lineage

A summaries file records the transcript it was prepared for, and applying it to a different session is a hard error rather than a silent mis-assembly. Compacted sessions carry their ancestor session ids, so a session that has been compacted several times can still report where it came from. Human prompts queued *during* a compaction survive it rather than being dropped.

Claude Code's own `/compact` recap — the `isCompactSummary` row it writes when it auto-summarizes — is recognized and is **not** treated as something you typed, so it does not get pinned into the verbatim layer and copied forward forever.

## `--fork` is experimental

Fork subagents (`Agent(subagent_type: "fork")`) ship inside Claude Code behind a staged rollout. If your install doesn't have them yet, enable them explicitly:

```jsonc
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_FORK_SUBAGENT": "1" } }
```

This is an undocumented feature flag: it may change or disappear in any Claude Code release. The payload tells the model what to do if the fork type is unavailable (suggest the env var, or fall back to `--subagent`).

**Cost honesty:** each fork re-reads the parent's full live context at cache-read pricing. Two forks on a large session ran ~650k tokens total. Parallelism buys wall-clock time, not tokens.

## Caveats

- This plugin parses Claude Code's **undocumented session-transcript internals** (JSONL rows, turn chaining, compaction markers). Any Claude Code release can break it. There is a test suite (`bun test`, over synthetic transcripts only) to catch drift — expect breakage, file issues.
- Requires [bun](https://bun.sh) on `PATH` (the hook, scripts, and MCP server run raw TypeScript via bun; `@modelcontextprotocol/sdk` resolves via bun auto-install, or run `bun install`).
- Omission caches live in `~/.claude/riverbed-compact/{sessionId}.json`. Retrieval falls back to the `~/.claude/magic-compact/` cache, and marker rows are dual-stamped (`riverbedCompact` + the upstream `magicCompact` field), so sessions compacted by either plugin remain mutually recompactable. (Retrieval compatibility is one-directional: this plugin reads upstream's omission cache, not vice versa.)

## Install

```
/plugin marketplace add https://github.com/CodyWhatleyMD/riverbed-compact
/plugin install riverbed-compact@riverbed
```

Run `/reload-plugins` if Claude Code is already open.

## Development

```
bun install         # dev deps (typescript, types)
bun run typecheck   # tsc --noEmit
bun test            # parser, payload, merge/assembly round-trip, era collapse, prune, hook e2e
```

Tests only ever touch synthetic transcripts in temp directories — never real sessions. The omission cache is redirected to a temp directory by a preload (`tests/setup.ts`, wired in `bunfig.toml`) for the whole run, and a test asserts that redirect is in place.

## Attribution

Forked from [aerovato/magic-compact](https://github.com/aerovato/magic-compact), Copyright (c) 2026 Kevin Liao @ Aerovato Research, BSD-3-Clause — the lossless rebuild engine (omission cache, `read_omitted_content`, transcript reconstruction) is upstream's design. This fork replaces the headless summarizer with live-session authorship (inline / fork / subagent workers), adds the self-guiding command, boundary-anchored merging, scaffold dropping, and era collapse. Modifications copyright (c) 2026 Cody Whatley (CodyWhatleyMD). See [LICENSE.md](LICENSE.md).
