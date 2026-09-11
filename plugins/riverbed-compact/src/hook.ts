import {
  collapseCandidates,
  loadErasFile,
  retireErasFile,
  splitPrefixIntoEras,
  ERAS_FILENAME,
  erasPath,
} from "./eras";
import { createPlan as createEraPlan } from "./compact";
import { readActiveTranscriptRows as readActiveRowsForEras } from "./transcript";
import { transcriptId as eraTranscriptId } from "./summaries";
import { turnUserPreview } from "./fork";
import { isRecord } from "./transcript";
import { unlink } from "node:fs/promises";
import { compactTranscript } from "./compact";
import { parseHookInput, parseRiverbedCompactCommand } from "./command";
import { buildOrchestrationPayload } from "./fork";
import { summariesPath } from "./summaries";
import {
  appendCustomTitle,
  createTranscriptSession,
  resolveSessionTitle,
} from "./transcript";

type HookOutput = {
  continue?: false;
  suppressOutput?: boolean;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
};

async function main(): Promise<void> {
  try {
    const input = parseHookInput(await Bun.stdin.text());

    // /whoami — a session inventory. Four session-identity mix-ups happened
    // in one day (2026-08-27): a session mis-diagnosed its own compaction,
    // one verified its text against the wrong transcript file and claimed it,
    // a command was typed into the wrong terminal tab, and a measurement
    // conflated two sessions' files. All four trace to the same gap — nothing
    // answers "which session am I, and which file is mine" from inside.
    // Anchored like the compact matcher, and for the same reason: unanchored,
    // quoting the tag in a sentence hijacked the turn (see commandXmlPattern).
    if (/^\/(?:riverbed-compact:)?whoami\b/.test(input.prompt.trim())
        || /^<command-message>[^<]*<\/command-message>\s*<command-name>\/(?:riverbed-compact:)?whoami<\/command-name>/
             .test(input.prompt)) {
      writeHookOutput({
        continue: false,
        stopReason: await buildWhoamiReport(
          input.session_id,
          input.transcript_path,
        ),
      });
      return;
    }

    const command = parseRiverbedCompactCommand(input.prompt);
    if (command === null) {
      writeHookOutput({ suppressOutput: true });
      return;
    }
    const { keepTurns, worker, eras } = command;

    // --eras: mode-B twin for era collapse. The LIVE session authors the
    // stub texts — an era stub is the last form the material takes, so it is
    // written by the session that has the material rather than by a worker
    // reading it cold. No file yet -> inject the era authoring instructions;
    // file present -> validated at assembly below.
    let eraTexts: Record<string, string> | null = null;
    // An existing valid eras file ALWAYS wins, flag or no flag — mirroring
    // the summaries rule. The two-round authoring flow hands the user a
    // final command printed by merge.ts, which doesn't carry --eras; on
    // 2026-08-27 that dropped the flag at the handoff and a fully-authored
    // era file sat ignored while the session was compacted at 950k. Curation
    // someone deliberately authored and stamped is intent; a flag is not
    // allowed to be the only thing standing between it and the bed.
    // (A file stamped for a DIFFERENT session still hard-fails in
    // loadErasFile — auto-use never crosses the stamp guard.)
    if (eras === null) {
      const erasFile = await loadErasFile(input.transcript_path).catch(
        () => null,
      );
      if (erasFile !== null) {
        eraTexts = erasFile.eras;
      }
    }
    if (eras !== null) {
      const erasFile = await loadErasFile(input.transcript_path);
      if (erasFile === null) {
        const payload = await buildEraAuthoringPayload(
          input.transcript_path,
          eras,
        );
        if (payload !== null) {
          writeHookOutput({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: payload,
            },
          });
          return;
        }
        // No collapsible eras — proceed as a plain compaction.
      } else {
        eraTexts = erasFile.eras;
      }
    }

    // Self-guiding command: the hook cannot author summaries (inline needs
    // the live context; forks/subagents are dispatched by the live instance,
    // not by us). So when no summaries file exists yet, hand the plan +
    // mode-specific instructions to the model as context and let the prompt
    // through (see fork.ts). An existing summaries file always wins: fall
    // through and assemble the compacted session from it.
    const prepared = await Bun.file(
      summariesPath(input.transcript_path),
    ).exists();
    if (!prepared) {
      const payload = await buildOrchestrationPayload(
        input.transcript_path,
        keepTurns,
        worker,
      );
      if (payload !== null) {
        writeHookOutput({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: payload,
          },
        });
        return;
      }
      // Nothing to summarize — fall through; compaction handles/skips it.
    }

    const destination = await createTranscriptSession(input.transcript_path);
    const compacted = await compactTranscript(
      input.transcript_path,
      destination.transcriptPath,
      destination.sessionId,
      keepTurns,
      input.cwd,
      eraTexts === null
        ? null
        : { keepNewest: eras ?? 1, texts: eraTexts },
    );
    if (!compacted) {
      await unlink(destination.transcriptPath).catch(() => undefined);
      writeHookOutput({
        continue: false,
        stopReason:
          "Riverbed Compact skipped: no older assistant turns to compact.",
      });
      return;
    }

    try {
      const title = await resolveSessionTitle(input.transcript_path);
      if (title !== null) {
        const label = title.startsWith("[UNCOMPACTED] ")
          ? title
          : `[UNCOMPACTED] ${title}`;
        await appendCustomTitle(input.transcript_path, input.session_id, label);
      }
    } catch {
      // Best-effort labeling; compaction already succeeded.
    }

    if (eraTexts !== null) {
      await retireErasFile(input.transcript_path);
    }
    // Inventory, not verdict: every count is printed, so a zero that should
    // not be zero announces itself in the same breath as the claim. And the
    // cold-door truth learned 2026-08-27: an in-place /resume switches the
    // transcript file but carries the OLD window with it — the savings exist
    // only through a cold load.
    writeHookOutput({
      continue: false,
      stopReason: [
        `Riverbed Compact wrote ${destination.sessionId}:`,
        `  summaries consumed: ${compacted.summariesConsumed}`
          + ` · eras collapsed: ${compacted.erasCollapsed}`
          + ` · rows written: ${compacted.rowsWritten}`,
        `  plan: prefix=${compacted.prefixTurns}`
          + ` summarized=${compacted.summarizedTurns}`
          + ` preserved=${compacted.preservedTurns}`
          + ` · stamped ${compacted.stamp.slice(0, 8)}`,
        "",
        "Your CURRENT window is unchanged — the savings exist only in the new",
        "session, loaded cold. Exit this client fully, then:",
        `  claude --resume ${destination.sessionId}`,
        "(An in-place /resume carries this window's weight with you.)",
      ].join("\n"),
    });
  } catch (error) {
    writeHookOutput({
      continue: false,
      stopReason: `Riverbed Compact failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function writeHookOutput(output: HookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();

/**
 * Era-authoring instructions for the live instance. Lists every collapse
 * candidate with its span and previews; the stub contract is DIAGNOSTIC text
 * (discriminate this era from the others — cue-shaped, not summary-shaped),
 * pinned verbatims embedded exactly.
 */
async function buildEraAuthoringPayload(
  transcriptPath: string,
  keepNewest: number,
): Promise<string | null> {
  const rows = await readActiveRowsForEras(transcriptPath);
  const plan = createEraPlan(rows, 1);
  const candidates = collapseCandidates(
    splitPrefixIntoEras(plan.prefixTurns),
    keepNewest,
  );
  if (candidates.length === 0) {
    return null;
  }
  const listing = candidates
    .map(era => {
      const previews = era.turns
        .slice(0, 4)
        .map(turn => `      - ${turnUserPreview(turn)}`)
        .join("\n");
      return [
        `  era ${era.key}`,
        `    span ${era.firstTimestamp.slice(0, 10)} → ${era.lastTimestamp.slice(0, 10)}, ${era.turns.length} turns; first user lines:`,
        previews,
      ].join("\n");
    })
    .join("\n");
  return [
    "[riverbed-compact --eras] No era file exists yet, so nothing was collapsed. YOU (the live instance) author the era stubs now. A stub is the last form its era takes, so it is written here rather than by a worker reading the rows cold. Then the user re-runs the same command to assemble.",
    `collapse candidates (keeping the ${keepNewest} newest era(s) uncollapsed):`,
    listing,
    "Stub contract: one entry per era. DIAGNOSTIC text, not a summary — write what discriminates THIS era from the others (names, decisions, artifacts, dates), because the stub's job is to cue retrieval, not to narrate. Embed the era's pinned verbatims EXACTLY. User rows survive whole automatically — do not restate them. The era's full rows stay retrievable via the Content ID printed in the stub row.",
    `Write ${erasPath(transcriptPath)} containing {"transcript": "${eraTranscriptId(transcriptPath)}", "eras": {"<era key>": "<stub text>", ...}}. The "transcript" stamp is what stops another session in this project from consuming your eras — include it verbatim.`,
    "Then re-run the exact same /riverbed-compact command to assemble. Before you do: if this project keeps durable notes, write down anything not yet recorded — it is cheaper to write it now, at full detail, than to reconstruct it from a stub later.",
  ].join("\n\n");
}

/** Identity as an inventory: session, file, size, rows, resident, lineage. */
async function buildWhoamiReport(
  sessionId: string,
  transcriptPath: string,
): Promise<string> {
  const file = Bun.file(transcriptPath);
  const exists = await file.exists();
  if (!exists) {
    return [
      `You are session ${sessionId}.`,
      `Transcript: ${transcriptPath} (not yet written — fresh session).`,
    ].join("\n");
  }
  const text = await file.text();
  const lines = text.split("\n").filter(Boolean);
  let resident = 0;
  let lastTimestamp = "";
  const ancestors = new Set<string>();
  let unparseable = 0;
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // ONLY JSON.parse may be swallowed. A wider catch here converted a
      // missing import into "0 tokens" with a straight face — an error-eating
      // catch is a success message that lies (found by running this very
      // report on its builder's own session, 2026-08-30).
      unparseable += 1;
      continue;
    }
    const sid = row["sessionId"];
    if (typeof sid === "string" && sid !== sessionId) {
      ancestors.add(sid);
    }
    if (typeof row["timestamp"] === "string") {
      lastTimestamp = row["timestamp"] as string;
    }
    const message = row["message"];
    if (isRecord(message) && isRecord(message["usage"])) {
      const usage = message["usage"] as Record<string, number>;
      const total =
        (usage["input_tokens"] ?? 0)
        + (usage["cache_read_input_tokens"] ?? 0)
        + (usage["cache_creation_input_tokens"] ?? 0);
      if (total > 0) {
        resident = total;
      }
    }
  }
  const megabytes = (text.length / 1048576).toFixed(1);
  return [
    `You are session ${sessionId}.`,
    `  file: ${transcriptPath}`,
    `  ${megabytes}MB · ${lines.length} rows · last row ${lastTimestamp.slice(0, 19) || "(no timestamp)"}`,
    `  resident context (last usage row): ${resident.toLocaleString()} tokens`
      + (unparseable > 0 ? ` · ${unparseable} unparseable rows skipped` : ""),
    ancestors.size > 0
      ? `  ancestor session ids in this file: ${[...ancestors].map(a => a.slice(0, 8)).join(", ")}`
      : "  no ancestor session ids in this file (never compacted)",
  ].join("\n");
}