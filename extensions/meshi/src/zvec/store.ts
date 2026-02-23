/** Zvec — In-memory vector store with brute-force search. */

import { saveStore, loadStore } from "./persistence.js";
import { cosineSimilarity } from "./similarity.js";
import type { VectorEntry, VectorStoreConfig, SearchResult } from "./types.js";

export class VectorStore {
  readonly name: string;
  readonly dimensions: number;
  private entries: Map<string, VectorEntry> = new Map();

  constructor(config: VectorStoreConfig) {
    this.name = config.name;
    this.dimensions = config.dimensions;
  }

  /** Number of entries in the store. */
  get size(): number {
    return this.entries.size;
  }

  /** Insert or update an entry. */
  upsert(id: string, vector: Float32Array, metadata: Record<string, unknown> = {}): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }
    this.entries.set(id, { id, vector, metadata });
  }

  /** Remove an entry by id. Returns true if it existed. */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Check if an entry exists. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Get an entry by id. */
  get(id: string): VectorEntry | undefined {
    return this.entries.get(id);
  }

  /** Brute-force search for the topK most similar vectors to the query. */
  search(queryVector: Float32Array, topK = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`,
      );
    }
    const scored: SearchResult[] = [];
    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(queryVector, entry.vector);
      scored.push({ id: entry.id, score, metadata: entry.metadata });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Persist the store to disk. */
  async save(): Promise<void> {
    await saveStore(this.name, this.entries);
  }

  /** Load entries from disk, replacing any current entries. */
  async load(): Promise<void> {
    const loaded = await loadStore(this.name, this.dimensions);
    this.entries = loaded;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }
}
