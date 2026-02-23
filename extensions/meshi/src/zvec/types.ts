/** Zvec — Local vector store types. */

/** A single stored vector entry with metadata. */
export type VectorEntry = {
  id: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
};

/** A search result returned from the vector store. */
export type SearchResult = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
};

/** Configuration for a VectorStore instance. */
export type VectorStoreConfig = {
  /** Human-readable store name (used for persistence filename). */
  name: string;
  /** Dimensionality of vectors. Must match the embedding provider output. */
  dimensions: number;
};

/** Provider interface for generating embeddings from text. */
export type EmbeddingProvider = {
  /** Generate an embedding vector for the given text. */
  embed(text: string): Promise<Float32Array>;
  /** The dimensionality of vectors produced by this provider. */
  dimensions: number;
};
