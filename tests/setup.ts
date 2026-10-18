/**
 * Preloaded before every test file (see bunfig.toml).
 *
 * omission.ts resolves its cache directory from TIERED_COMPACT_CACHE_DIR at
 * call time, falling back to the user's real ~/.claude/tiered-compact. Six
 * test files were writing omission caches into that real directory — including
 * ones that set the variable themselves in beforeAll, because a sibling file's
 * afterAll `delete`s it from the shared process environment mid-run.
 *
 * Per-file setup is the wrong shape for a process-global. One preload covers
 * every test file, including ones not written yet, and makes the README's
 * "never real sessions" true by construction rather than by discipline.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TIERED_COMPACT_CACHE_DIR"] = mkdtempSync(
  join(tmpdir(), "tiered-test-cache-"),
);
