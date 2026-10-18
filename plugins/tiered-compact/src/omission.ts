import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

type OmissionEntry = {
  content: string;
};

type OmissionCache = {
  version: 1;
  nextId: number;
  entries: Record<string, OmissionEntry>;
};

export async function loadOmissionCache(
  sessionId: string,
): Promise<OmissionCache> {
  return loadOmissionCacheFromFile(cachePath(sessionId));
}

export async function saveOmissionCache(
  sessionId: string,
  cache: OmissionCache,
): Promise<void> {
  const path = cachePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
}

export function allocateOmission(
  cache: OmissionCache,
  sessionId: string,
  content: string,
): string {
  const contentId = `${sessionId.slice(-12)}:omitted-${cache.nextId.toString().padStart(3, "0")}`;
  cache.nextId += 1;
  cache.entries[contentId] = { content };
  return contentId;
}

export async function readOmittedContent(
  contentId: string,
): Promise<string | null> {
  const [sessionSuffix] = contentId.split(":", 1);
  if (!sessionSuffix || sessionSuffix.length !== 12) {
    return null;
  }

  // Search the Tiered Compact cache first, then fall back to the upstream Magic
  // Compact cache so omissions from sessions compacted by the original
  // plugin remain retrievable.
  for (const directory of [cacheDirectory(), legacyCacheDirectory()]) {
    const sessionId = await findSessionIdBySuffix(directory, sessionSuffix);
    if (!sessionId) {
      continue;
    }

    const cache = await loadOmissionCacheFromFile(
      `${directory}/${sessionId}.json`,
    );
    const content = cache.entries[contentId]?.content;
    if (content !== undefined) {
      return content;
    }
  }

  return null;
}

export function inputOmissionNotice(
  description: string,
  length: number,
  contentId: string,
): string {
  return `<tool-input-omission-notice>
${description}

Omitted Length: ${length} characters
Content ID: ${contentId}
</tool-input-omission-notice>`;
}

export function outputOmissionNotice(
  description: string,
  length: number,
  contentId: string,
): string {
  return `<tool-output-omission-notice>
${description}

Output Length: ${length} characters
Content ID: ${contentId}
</tool-output-omission-notice>`;
}

async function loadOmissionCacheFromFile(path: string): Promise<OmissionCache> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return createEmptyCache();
  }

  const value: unknown = await file.json();
  if (!isOmissionCache(value)) {
    return createEmptyCache();
  }

  return value;
}

async function findSessionIdBySuffix(
  directory: string,
  suffix: string,
): Promise<string | null> {
  try {
    const entries = await readdir(directory);
    for (const entry of entries) {
      if (entry === `${suffix}.json` || entry.endsWith(`${suffix}.json`)) {
        return entry.slice(0, -".json".length);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function cachePath(sessionId: string): string {
  return `${cacheDirectory()}/${sessionId}.json`;
}

function cacheDirectory(): string {
  return (
    process.env["TIERED_COMPACT_CACHE_DIR"]
    ?? `${homedir()}/.claude/tiered-compact`
  );
}

function legacyCacheDirectory(): string {
  return `${homedir()}/.claude/magic-compact`;
}

function createEmptyCache(): OmissionCache {
  return {
    version: 1,
    nextId: 1,
    entries: {},
  };
}

function isOmissionCache(value: unknown): value is OmissionCache {
  return (
    typeof value === "object"
    && value !== null
    && "version" in value
    && value.version === 1
    && "nextId" in value
    && typeof value.nextId === "number"
    && "entries" in value
    && typeof value.entries === "object"
    && value.entries !== null
  );
}
