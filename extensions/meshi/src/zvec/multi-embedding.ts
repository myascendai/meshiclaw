/**
 * Zvec — Multi-facet embedding system.
 *
 * Instead of a single embedding per person, we create separate embeddings
 * for different facets (role, industry, expertise, composite). This allows
 * queries to match on the most relevant dimension of a person's identity.
 *
 * Architecture:
 *   PersonFields → buildFacetTexts() → embed each facet → store in MultiVectorStore
 *   Query → analyzeQuery() → embed with facet-specific text → multi-search → fuse results
 */

import { fusionSearch, type FacetScore, type FusedResult, type FusionMethod } from "./fusion.js";
import { analyzeQuery, type FacetWeights } from "./query-analyzer.js";
import { cosineSimilarity } from "./similarity.js";
import { VectorStore } from "./store.js";
import { buildFacetTexts, type PersonFields, type FacetTexts } from "./text-enrichment.js";
import type { EmbeddingProvider, SearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Multi-vector store
// ---------------------------------------------------------------------------

export type MultiVectorStoreConfig = {
  name: string;
  dimensions: number;
};

/**
 * A store that maintains separate vector stores for each facet.
 * Each person has up to 4 embeddings, one per facet.
 */
export class MultiVectorStore {
  readonly name: string;
  readonly dimensions: number;

  /** Per-facet vector stores */
  private facetStores: {
    role: VectorStore;
    industry: VectorStore;
    expertise: VectorStore;
    composite: VectorStore;
  };

  /** Shared metadata (stored once, not per-facet) */
  private metadata: Map<string, Record<string, unknown>> = new Map();

  constructor(config: MultiVectorStoreConfig) {
    this.name = config.name;
    this.dimensions = config.dimensions;
    this.facetStores = {
      role: new VectorStore({ name: `${config.name}-role`, dimensions: config.dimensions }),
      industry: new VectorStore({ name: `${config.name}-industry`, dimensions: config.dimensions }),
      expertise: new VectorStore({
        name: `${config.name}-expertise`,
        dimensions: config.dimensions,
      }),
      composite: new VectorStore({
        name: `${config.name}-composite`,
        dimensions: config.dimensions,
      }),
    };
  }

  get size(): number {
    return this.metadata.size;
  }

  /** Index a person with multi-facet embeddings. */
  async upsertPerson(
    id: string,
    fields: PersonFields,
    provider: EmbeddingProvider,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<void> {
    const facetTexts = buildFacetTexts(fields);

    // Generate embeddings for each facet in parallel
    const [roleVec, industryVec, expertiseVec, compositeVec] = await Promise.all([
      provider.embed(facetTexts.role),
      provider.embed(facetTexts.industry),
      provider.embed(facetTexts.expertise),
      provider.embed(facetTexts.composite),
    ]);

    // Store vectors in per-facet stores
    const meta = { ...extraMetadata, ...fields };
    this.facetStores.role.upsert(id, roleVec, meta);
    this.facetStores.industry.upsert(id, industryVec, meta);
    this.facetStores.expertise.upsert(id, expertiseVec, meta);
    this.facetStores.composite.upsert(id, compositeVec, meta);

    // Store shared metadata
    this.metadata.set(id, {
      ...meta,
      facet_texts: facetTexts,
    });
  }

  /**
   * Multi-facet search: embed the query, score against each facet store,
   * then fuse results using the specified method.
   */
  async search(
    query: string,
    provider: EmbeddingProvider,
    topK = 10,
    options: {
      weights?: FacetWeights;
      method?: FusionMethod;
      adaptiveWeights?: boolean;
    } = {},
  ): Promise<FusedResult[]> {
    const { method = "weighted_sum", adaptiveWeights = true } = options;

    // Analyze query to determine intent and adaptive weights
    const analysis = analyzeQuery(query);
    const weights = options.weights ??
      (adaptiveWeights ? analysis.weights : undefined) ?? {
        role: 0.25,
        industry: 0.25,
        expertise: 0.25,
        composite: 0.25,
      };

    // Embed the query (possibly expanded)
    const queryText = adaptiveWeights ? analysis.expandedQuery : query;
    const queryVec = await provider.embed(queryText);

    // Score each person against each facet
    const candidateMap = new Map<string, FacetScore>();

    for (const id of this.metadata.keys()) {
      const roleEntry = this.facetStores.role.get(id);
      const industryEntry = this.facetStores.industry.get(id);
      const expertiseEntry = this.facetStores.expertise.get(id);
      const compositeEntry = this.facetStores.composite.get(id);

      if (!roleEntry || !industryEntry || !expertiseEntry || !compositeEntry) continue;

      candidateMap.set(id, {
        id,
        metadata: this.metadata.get(id) ?? {},
        scores: {
          role: cosineSimilarity(queryVec, roleEntry.vector),
          industry: cosineSimilarity(queryVec, industryEntry.vector),
          expertise: cosineSimilarity(queryVec, expertiseEntry.vector),
          composite: cosineSimilarity(queryVec, compositeEntry.vector),
        },
      });
    }

    const candidates = Array.from(candidateMap.values());
    return fusionSearch(candidates, weights, topK, method);
  }

  /**
   * Search with a specific facet only (useful for A/B testing).
   */
  async searchSingleFacet(
    query: string,
    facet: keyof typeof this.facetStores,
    provider: EmbeddingProvider,
    topK = 10,
  ): Promise<SearchResult[]> {
    const queryVec = await provider.embed(query);
    return this.facetStores[facet].search(queryVec, topK);
  }

  /** Get raw facet scores for a specific person against a query vector. */
  getFacetScores(id: string, queryVec: Float32Array): FacetScore["scores"] | null {
    const roleEntry = this.facetStores.role.get(id);
    const industryEntry = this.facetStores.industry.get(id);
    const expertiseEntry = this.facetStores.expertise.get(id);
    const compositeEntry = this.facetStores.composite.get(id);

    if (!roleEntry || !industryEntry || !expertiseEntry || !compositeEntry) return null;

    return {
      role: cosineSimilarity(queryVec, roleEntry.vector),
      industry: cosineSimilarity(queryVec, industryEntry.vector),
      expertise: cosineSimilarity(queryVec, expertiseEntry.vector),
      composite: cosineSimilarity(queryVec, compositeEntry.vector),
    };
  }

  has(id: string): boolean {
    return this.metadata.has(id);
  }

  delete(id: string): boolean {
    this.facetStores.role.delete(id);
    this.facetStores.industry.delete(id);
    this.facetStores.expertise.delete(id);
    this.facetStores.composite.delete(id);
    return this.metadata.delete(id);
  }

  clear(): void {
    this.facetStores.role.clear();
    this.facetStores.industry.clear();
    this.facetStores.expertise.clear();
    this.facetStores.composite.clear();
    this.metadata.clear();
  }

  /** Persist all facet stores to disk. */
  async save(): Promise<void> {
    await Promise.all([
      this.facetStores.role.save(),
      this.facetStores.industry.save(),
      this.facetStores.expertise.save(),
      this.facetStores.composite.save(),
    ]);
  }

  /** Load all facet stores from disk. */
  async load(): Promise<void> {
    await Promise.all([
      this.facetStores.role.load(),
      this.facetStores.industry.load(),
      this.facetStores.expertise.load(),
      this.facetStores.composite.load(),
    ]);

    // Rebuild metadata from composite store (it has all fields)
    for (const [id, entry] of Array.from(
      // Access internal entries via search trick
      (() => {
        const store = this.facetStores.composite;
        const allResults = store.search(new Float32Array(this.dimensions), store.size);
        return allResults.map((r) => [r.id, { metadata: r.metadata }] as const);
      })(),
    )) {
      this.metadata.set(id, entry.metadata);
    }
  }

  /** Get the list of all indexed person IDs. */
  ids(): string[] {
    return Array.from(this.metadata.keys());
  }

  /** Get metadata for a person. */
  getMetadata(id: string): Record<string, unknown> | undefined {
    return this.metadata.get(id);
  }
}
