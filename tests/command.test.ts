import { describe, expect, test } from "bun:test";
import { parseTieredCompactCommand } from "../plugins/tiered-compact/src/command";

describe("parseTieredCompactCommand", () => {
  test("plain command defaults to inline worker", () => {
    expect(parseTieredCompactCommand("/tiered-compact 8")).toEqual({
      keepTurns: 8,
      worker: { type: "inline" },
      eras: null,
    });
    // No N given is NOT N=0 — see "omitted N is not zero" below.
    expect(parseTieredCompactCommand("/tiered-compact")).toEqual({
      keepTurns: null,
      worker: { type: "inline" },
      eras: null,
    });
  });

  test("--fork with and without count", () => {
    expect(parseTieredCompactCommand("/tiered-compact 8 --fork 4")).toEqual(
      { keepTurns: 8, worker: { type: "fork", count: 4 }, eras: null },
    );
    expect(parseTieredCompactCommand("/tiered-compact 8 --fork")).toEqual({
      keepTurns: 8,
      worker: { type: "fork", count: null },
      eras: null,
    });
  });

  test("--subagent with optional count and model", () => {
    expect(
      parseTieredCompactCommand("/tiered-compact 8 --subagent 6"),
    ).toEqual({
      keepTurns: 8,
      worker: { type: "subagent", count: 6, model: null },
      eras: null,
    });
    expect(
      parseTieredCompactCommand(
        "/tiered-compact 8 --subagent 6 --model claude-haiku-4-5-20251001",
      ),
    ).toEqual({
      keepTurns: 8,
      worker: {
        type: "subagent",
        count: 6,
        model: "claude-haiku-4-5-20251001",
      },
      eras: null,
    });
  });

  test("namespaced form parses identically", () => {
    expect(
      parseTieredCompactCommand(
        "/tiered-compact:tiered-compact 3 --fork 2",
      ),
    ).toEqual({ keepTurns: 3, worker: { type: "fork", count: 2 }, eras: null });
  });

  test("non-command prompts return null", () => {
    expect(parseTieredCompactCommand("hello world")).toBeNull();
    expect(parseTieredCompactCommand("/tiered")).toBeNull();
  });

  test("invalid forms throw usage errors", () => {
    const bad = [
      "/tiered-compact 8 --fork 4 --subagent 2",
      "/tiered-compact 8 --fork 99",
      "/tiered-compact 8 --fork 0",
      "/tiered-compact 8 --model haiku",
      "/tiered-compact 8 --fork --model haiku",
      "/tiered-compact 8 --bogus",
      "/tiered-compact 8 --model",
      "/tiered-compact abc",
    ];
    for (const prompt of bad) {
      expect(() => parseTieredCompactCommand(prompt)).toThrow();
    }
  });
});

describe("--eras parsing", () => {
  test("bare --eras defaults to keeping 1 newest era", () => {
    expect(parseTieredCompactCommand("/tiered-compact 7 --eras")).toEqual({
      keepTurns: 7,
      worker: { type: "inline" },
      eras: 1,
    });
  });

  test("--eras with explicit count", () => {
    expect(parseTieredCompactCommand("/tiered-compact --eras 3")).toEqual({
      keepTurns: null,
      worker: { type: "inline" },
      eras: 3,
    });
  });

  test("--eras 0 is rejected", () => {
    expect(() => parseTieredCompactCommand("/tiered-compact --eras 0")).toThrow();
  });

  test("--eras composes with a worker flag", () => {
    expect(
      parseTieredCompactCommand("/tiered-compact 5 --subagent 4 --eras 2"),
    ).toEqual({
      keepTurns: 5,
      worker: { type: "subagent", count: 4, model: null },
      eras: 2,
    });
  });
});

describe("slash-command XML dispatch (2026-08-27)", () => {
  test("the menu-dispatched XML form parses like the raw form", () => {
    // The exact shape from the live transcript where the hook failed to fire
    // and an authored eras file sat unconsumed at 950k.
    const xml =
      "<command-message>tiered-compact:tiered-compact</command-message>\n"
      + "<command-name>/tiered-compact:tiered-compact</command-name>\n"
      + "<command-args>--eras</command-args>";
    expect(parseTieredCompactCommand(xml)).toEqual({
      keepTurns: null,
      worker: { type: "inline" },
      eras: 1,
    });
  });

  test("XML form with N and worker flags", () => {
    const xml =
      "<command-message>tiered-compact</command-message>\n"
      + "<command-name>/tiered-compact</command-name>"
      + "<command-args>12 --subagent 4 --eras 2</command-args>";
    expect(parseTieredCompactCommand(xml)).toEqual({
      keepTurns: 12,
      worker: { type: "subagent", count: 4, model: null },
      eras: 2,
    });
  });

  // The XML pattern used to search ANYWHERE in the prompt, so merely quoting
  // the tags — asking why the hook didn't fire, pasting a transcript excerpt —
  // parsed as a live command and dispatched a real compaction with real
  // workers. Two such prompts exist in this machine's own history. Every one
  // of the 807 genuine dispatches begins with <command-message>, so requiring
  // it at the head costs nothing and closes the hole.
  test("the tags quoted mid-sentence are NOT a command", () => {
    expect(parseTieredCompactCommand(
      "why did <command-name>/tiered-compact</command-name>"
      + "<command-args>45 --fork 5</command-args> not fire yesterday?",
    )).toBeNull();
  });

  test("a whole dispatch block pasted mid-message is NOT a command", () => {
    expect(parseTieredCompactCommand(
      "for reference I ran: <command-message>tiered-compact</command-message>\n"
      + "<command-name>/tiered-compact</command-name>"
      + "<command-args>20</command-args>\nand it worked",
    )).toBeNull();
  });

  test("the real dispatch shape still parses", () => {
    expect(parseTieredCompactCommand(
      "<command-message>tiered-compact:tiered-compact</command-message>\n"
      + "<command-name>/tiered-compact:tiered-compact</command-name>\n"
      + "<command-args>20</command-args>",
    )).toEqual({ keepTurns: 20, worker: { type: "inline" }, eras: null });
  });

  test("XML for a different command is not intercepted", () => {
    expect(
      parseTieredCompactCommand(
        "<command-name>/other-command</command-name><command-args>--eras</command-args>",
      ),
    ).toBeNull();
  });
});

// `--eras` alone used to parse to keepTurns 0, and createPlan reads
// `keepTurns <= 0` as "summarize every turn" — so asking for a deep-history
// pass silently compacted the entire live working thread. An omitted N is not
// a zero.
describe("omitted N is not zero", () => {
  test("--eras alone leaves N unset", () => {
    expect(parseTieredCompactCommand("/tiered-compact --eras")?.keepTurns)
      .toBeNull();
  });

  test("an explicit 0 is still an explicit 0", () => {
    expect(parseTieredCompactCommand("/tiered-compact 0")?.keepTurns).toBe(0);
  });

  test("an omitted N preserves the live conversation; 0 summarizes it", async () => {
    const { createPlan } = await import("../plugins/tiered-compact/src/compact");
    const { assistantRow, chainRows, textBlock, userRow } = await import("./helpers");
    const groups = [];
    let parent: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const u = userRow(`q${i}`, parent);
      const a = assistantRow([textBlock(`a${i}`)], u.uuid);
      parent = a.uuid;
      groups.push([u, a]);
    }
    const rows = chainRows(groups);
    expect(createPlan(rows, null).summarizedTurns).toHaveLength(0);
    expect(createPlan(rows, null).preservedTurns).toHaveLength(5);
    expect(createPlan(rows, 0).summarizedTurns).toHaveLength(5);
    expect(createPlan(rows, 0).preservedTurns).toHaveLength(0);
  });
});
