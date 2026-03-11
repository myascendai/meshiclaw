/** Zvec — Local vector store public API. */

// Core store
export { VectorStore } from "./store.js";
export { cosineSimilarity } from "./similarity.js";
export { createMistralProvider, createHashProvider, createEmbeddingProvider } from "./embedding.js";
export type { VectorEntry, SearchResult, VectorStoreConfig, EmbeddingProvider } from "./types.js";

// Multi-facet system
export { MultiVectorStore } from "./multi-embedding.js";
export {
  buildFacetTexts,
  buildEmbeddingText,
  expandTitle,
  extractIndustry,
  detectSeniority,
} from "./text-enrichment.js";
export type { PersonFields, FacetTexts, TextStrategy } from "./text-enrichment.js";
export { analyzeQuery, WEIGHT_PRESETS } from "./query-analyzer.js";
export type { QueryIntent, QueryAnalysis, FacetWeights } from "./query-analyzer.js";
export {
  fusionSearch,
  weightedSumFusion,
  maxFacetFusion,
  reciprocalRankFusion,
  geometricMeanFusion,
} from "./fusion.js";
export type { FacetScore, FusedResult, FusionMethod } from "./fusion.js";
