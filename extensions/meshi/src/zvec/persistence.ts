/** Zvec — JSON Lines file-based persistence to ~/.openclaw/zvec/. */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VectorEntry } from "./types.js";

/** Serialized form of a VectorEntry for JSON Lines storage. */
type SerializedEntry = {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

function getStoreDir(): string {
  return path.join(os.homedir(), ".openclaw", "zvec");
}

function getStorePath(storeName: string): string {
  return path.join(getStoreDir(), `${storeName}.jsonl`);
}

/** Persist all entries to a JSON Lines file. */
export async function saveStore(
  storeName: string,
  entries: Map<string, VectorEntry>,
): Promise<void> {
  const dir = getStoreDir();
  await fs.mkdir(dir, { recursive: true });

  const lines: string[] = [];
  for (const entry of entries.values()) {
    const serialized: SerializedEntry = {
      id: entry.id,
      vector: Array.from(entry.vector),
      metadata: entry.metadata,
    };
    lines.push(JSON.stringify(serialized));
  }

  await fs.writeFile(getStorePath(storeName), lines.join("\n") + "\n", "utf-8");
}

/** Load entries from a JSON Lines file. Returns a Map of entries. */
export async function loadStore(
  storeName: string,
  dimensions: number,
): Promise<Map<string, VectorEntry>> {
  const filePath = getStorePath(storeName);
  const entries = new Map<string, VectorEntry>();

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet — return empty store
    return entries;
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SerializedEntry;
      if (parsed.vector.length !== dimensions) continue;
      entries.set(parsed.id, {
        id: parsed.id,
        vector: new Float32Array(parsed.vector),
        metadata: parsed.metadata,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}
