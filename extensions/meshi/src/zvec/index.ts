/** Zvec — Local vector store public API. */

export { VectorStore } from "./store.js";
export { cosineSimilarity } from "./similarity.js";
export { createMistralProvider, createHashProvider, createEmbeddingProvider } from "./embedding.js";
export type { VectorEntry, SearchResult, VectorStoreConfig, EmbeddingProvider } from "./types.js";
