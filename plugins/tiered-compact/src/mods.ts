import { cp, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A session's mods live in <config>/dev-mods/<session id>/, one child folder
 * per mod. Claude Code loads them only after the person enables hot reloading
 * for that session, and it records that yes against the session id, dropping
 * one carried over from another session. A crossing starts a new session, so
 * the mods stop loading (found 2026-10-18, the first crossing with mods).
 *
 * Tiered Compact copies the folder to the new id and tells the successor how to raise
 * the question again. It never writes the yes itself: Claude Code's own
 * guidance says that question is the person's alone, answered by no permission
 * mode, rule or hook. Writing it here would also load anything later placed in
 * the folder without the person seeing it.
 */

// The shape Claude Code accepts for a dev-mods folder name; anything else could
// steer the copy outside the mods root.
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function devModsRoot(): string {
  return process.env["TIERED_COMPACT_DEV_MODS_DIR"]
    ?? join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "dev-mods");
}

export type ModsCarry = { folder: string; mods: string[] };

async function modNames(folder: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await stat(join(folder, entry.name, ".claude-plugin", "plugin.json"));
      if (manifest.isFile()) names.push(entry.name);
    } catch {
      // not a mod folder
    }
  }
  return names.sort();
}

/**
 * Copies the old session's mods folder to the new session's. Returns null when
 * there is nothing to carry. Throws if the copy fails; the caller treats that as
 * "nothing carried" rather than failing the crossing.
 */
export async function carryDevMods(
  fromSessionId: string,
  toSessionId: string,
): Promise<ModsCarry | null> {
  if (!SESSION_ID.test(fromSessionId) || !SESSION_ID.test(toSessionId) || fromSessionId === toSessionId) {
    return null;
  }
  const root = devModsRoot();
  const mods = await modNames(join(root, fromSessionId));
  if (mods.length === 0) return null;
  const folder = join(root, toSessionId);
  await cp(join(root, fromSessionId), folder, { recursive: true, force: false, errorOnExist: true });
  return { folder, mods };
}

/** Removes a copy this run made, when the crossing it was made for didn't happen. */
export async function dropCarriedMods(carry: ModsCarry): Promise<void> {
  await rm(carry.folder, { recursive: true, force: true });
}

/** The paragraph the successor reads in its post-compaction notice. */
export function modsNotice(carry: ModsCarry): string {
  return [
    `This session's mods (${carry.mods.join(", ")}) were copied to ${carry.folder}/, but they don't load until the person enables hot reloading for this session.`,
    "At the start of your first turn, load the plugin-authoring skill with the Skill tool: that starts Claude Code's watch on the folder, and Claude Code asks the person \"Enable hot reloading for this session?\" when the turn ends.",
    "The answer is theirs. Don't write a dev-mods entry or otherwise answer it for them.",
  ].join(" ");
}
