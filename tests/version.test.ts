import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * Four places claimed four different versions at once — plugin.json 0.3.0,
 * package.json 0.1.0, the MCP server hardcoded 0.1.0, and the newest release
 * commit titled 0.2.0. Nothing checked, so nothing noticed.
 */
describe("version coherence", () => {
  test("plugin.json, package.json and the MCP server agree", async () => {
    const plugin = JSON.parse(await readFile(
      join(root, "plugins/riverbed-compact/.claude-plugin/plugin.json"), "utf8"));
    const pkg = JSON.parse(await readFile(
      join(root, "plugins/riverbed-compact/package.json"), "utf8"));
    const mcp = await readFile(
      join(root, "plugins/riverbed-compact/src/mcp.ts"), "utf8");
    expect(pkg.version).toBe(plugin.version);
    expect(mcp).toContain(`version: "${plugin.version}"`);
  });
});

/**
 * Six test files were writing omission caches into the user's real
 * ~/.claude/riverbed-compact/ — including ones that set the redirect
 * themselves, because a sibling's afterAll `delete`d it from the shared
 * process environment mid-run. The README promised "never real sessions".
 * This fails if the preload is removed or unset again.
 */
describe("the test suite never writes to the real cache", () => {
  test("the omission cache is redirected out of ~/.claude", () => {
    const dir = process.env["RIVERBED_COMPACT_CACHE_DIR"];
    expect(dir).toBeTruthy();
    expect(dir).not.toContain(".claude");
  });
});
