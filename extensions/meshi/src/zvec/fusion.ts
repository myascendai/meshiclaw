/**
 * Zvec — Result fusion strategies for combining multi-facet search results.
 *
 * When searching across multiple embedding facets (role, industry, expertise, etc.),
 * we need strategies to combine per-facet scores into a single ranking.
 */

import type { FacetWeights } from "./query-analyzer.js";

export type FacetScore = {
  id: string;
  metadata: Record<string, unknown>;
  scores: {
    role: number;
    industry: number;
    expertise: number;
    composite: number;
  };
};

export type FusedResult = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  /** Per-facet breakdown for analysis */
  facetScores: FacetScore["scores"];
  /** Which fusion method produced this score */
  method: string;
};

// ---------------------------------------------------------------------------
// Fusion method: Weighted sum
// ---------------------------------------------------------------------------

/**
 * Weighted sum fusion: score = sum(weight_i * sim_i).
 * The most straightforward approach. Weights determine facet importance.
 */
export function weightedSumFusion(
  candidates: FacetScore[],
  weights: FacetWeights,
  topK: number,
): FusedResult[] {
  const results: FusedResult[] = candidates.map((c) => ({
    id: c.id,
    score:
      c.scores.role * weights.role +
      c.scores.industry * weights.industry +
      c.scores.expertise * weights.expertise +
      c.scores.composite * weights.composite,
    metadata: c.metadata,
    facetScores: c.scores,
    method: "weighted_sum",
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Fusion method: Max-facet selection
// ---------------------------------------------------------------------------

/**
 * Max-facet fusion: score = max(sim_i * weight_i).
 * A person only needs to strongly match on ONE facet to rank high.
 * Good for exploratory queries where you don't know which facet matters.
 */
export function maxFacetFusion(
  candidates: FacetScore[],
  weights: FacetWeights,
  topK: number,
): FusedResult[] {
  const results: FusedResult[] = candidates.map((c) => ({
    id: c.id,
    score: Math.max(
      c.scores.role * weights.role,
      c.scores.industry * weights.industry,
      c.scores.expertise * weights.expertise,
      c.scores.composite * weights.composite,
    ),
    metadata: c.metadata,
    facetScores: c.scores,
    method: "max_facet",
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Fusion method: Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

/**
 * RRF: combine rankings from each facet using reciprocal rank scoring.
 * score = sum(1 / (k + rank_i)) where k is a smoothing constant (default 60).
 *
 * RRF is rank-based rather than score-based, making it robust to different
 * score distributions across facets.
 */
export function reciprocalRankFusion(
  candidates: FacetScore[],
  weights: FacetWeights,
  topK: number,
  k = 60,
): FusedResult[] {
  const allFacets: Array<{ key: keyof FacetScore["scores"]; weight: number }> = [
    { key: "role", weight: weights.role },
    { key: "industry", weight: weights.industry },
    { key: "expertise", weight: weights.expertise },
    { key: "composite", weight: weights.composite },
  ];
  const facets = allFacets.filter((f) => f.weight > 0);

  // Build per-facet rankings
  const rrfScores = new Map<string, number>();
  const metaMap = new Map<string, Record<string, unknown>>();
  const scoreMap = new Map<string, FacetScore["scores"]>();

  for (const facet of facets) {
    // Sort candidates by this facet's score
    const sorted = [...candidates].sort((a, b) => b.scores[facet.key] - a.scores[facet.key]);

    for (let rank = 0; rank < sorted.length; rank++) {
      const c = sorted[rank];
      const rrfContribution = facet.weight / (k + rank + 1);
      rrfScores.set(c.id, (rrfScores.get(c.id) ?? 0) + rrfContribution);
      metaMap.set(c.id, c.metadata);
      scoreMap.set(c.id, c.scores);
    }
  }

  const results: FusedResult[] = [];
  for (const [id, score] of rrfScores) {
    results.push({
      id,
      score,
      metadata: metaMap.get(id) ?? {},
      facetScores: scoreMap.get(id) ?? { role: 0, industry: 0, expertise: 0, composite: 0 },
      method: "rrf",
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Fusion method: Geometric mean
// ---------------------------------------------------------------------------

/**
 * Geometric mean fusion: score = prod(sim_i ^ weight_i).
 * Penalizes candidates that score poorly on ANY facet (even with
 * high scores on others). Good for finding well-rounded matches.
 */
export function geometricMeanFusion(
  candidates: FacetScore[],
  weights: FacetWeights,
  topK: number,
): FusedResult[] {
  const results: FusedResult[] = candidates.map((c) => {
    // Shift scores to [0.01, 1.01] range to avoid log(0) issues
    const shift = 0.01;
    const logScore =
      weights.role * Math.log(Math.max(c.scores.role + shift, shift)) +
      weights.industry * Math.log(Math.max(c.scores.industry + shift, shift)) +
      weights.expertise * Math.log(Math.max(c.scores.expertise + shift, shift)) +
      weights.composite * Math.log(Math.max(c.scores.composite + shift, shift));

    return {
      id: c.id,
      score: Math.exp(logScore),
      metadata: c.metadata,
      facetScores: c.scores,
      method: "geometric_mean",
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Score normalization utilities
// ---------------------------------------------------------------------------

/** Min-max normalize scores in an array to [0, 1]. */
export function normalizeScores(results: FusedResult[]): FusedResult[] {
  if (results.length === 0) return results;

  const scores = results.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;

  if (range === 0) {
    return results.map((r) => ({ ...r, score: 1 }));
  }

  return results.map((r) => ({
    ...r,
    score: (r.score - min) / range,
  }));
}

// ---------------------------------------------------------------------------
// Convenience: run all fusion methods for comparison
// ---------------------------------------------------------------------------

export type FusionMethod = "weighted_sum" | "max_facet" | "rrf" | "geometric_mean";

export function fusionSearch(
  candidates: FacetScore[],
  weights: FacetWeights,
  topK: number,
  method: FusionMethod = "weighted_sum",
): FusedResult[] {
  switch (method) {
    case "weighted_sum":
      return weightedSumFusion(candidates, weights, topK);
    case "max_facet":
      return maxFacetFusion(candidates, weights, topK);
    case "rrf":
      return reciprocalRankFusion(candidates, weights, topK);
    case "geometric_mean":
      return geometricMeanFusion(candidates, weights, topK);
  }
}
