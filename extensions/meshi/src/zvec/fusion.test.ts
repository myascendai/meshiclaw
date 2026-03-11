import { describe, it, expect } from "vitest";
import {
  weightedSumFusion,
  maxFacetFusion,
  reciprocalRankFusion,
  geometricMeanFusion,
  normalizeScores,
  type FacetScore,
} from "./fusion.js";

const UNIFORM_WEIGHTS = { role: 0.25, industry: 0.25, expertise: 0.25, composite: 0.25 };

function makeCandidates(): FacetScore[] {
  return [
    {
      id: "alice",
      metadata: { name: "Alice" },
      scores: { role: 0.9, industry: 0.3, expertise: 0.5, composite: 0.6 },
    },
    {
      id: "bob",
      metadata: { name: "Bob" },
      scores: { role: 0.4, industry: 0.8, expertise: 0.7, composite: 0.5 },
    },
    {
      id: "carol",
      metadata: { name: "Carol" },
      scores: { role: 0.6, industry: 0.6, expertise: 0.6, composite: 0.6 },
    },
  ];
}

describe("weightedSumFusion", () => {
  it("returns sorted results", () => {
    const results = weightedSumFusion(makeCandidates(), UNIFORM_WEIGHTS, 3);
    expect(results).toHaveLength(3);
    // Carol has uniform 0.6 in all facets = 0.6
    // Bob: 0.25*0.4 + 0.25*0.8 + 0.25*0.7 + 0.25*0.5 = 0.6
    // Alice: 0.25*0.9 + 0.25*0.3 + 0.25*0.5 + 0.25*0.6 = 0.575
    expect(results[0].score).toBeCloseTo(0.6);
    expect(results[2].id).toBe("alice");
  });

  it("respects topK", () => {
    const results = weightedSumFusion(makeCandidates(), UNIFORM_WEIGHTS, 1);
    expect(results).toHaveLength(1);
  });

  it("weights shift ranking", () => {
    const roleHeavy = { role: 0.7, industry: 0.1, expertise: 0.1, composite: 0.1 };
    const results = weightedSumFusion(makeCandidates(), roleHeavy, 3);
    expect(results[0].id).toBe("alice"); // Alice has highest role score
  });
});

describe("maxFacetFusion", () => {
  it("picks best facet per candidate", () => {
    const results = maxFacetFusion(makeCandidates(), UNIFORM_WEIGHTS, 3);
    // Alice: max(0.25*0.9, 0.25*0.3, 0.25*0.5, 0.25*0.6) = 0.225
    // Bob: max(0.25*0.4, 0.25*0.8, 0.25*0.7, 0.25*0.5) = 0.2
    expect(results[0].id).toBe("alice");
  });
});

describe("reciprocalRankFusion", () => {
  it("returns results for all candidates", () => {
    const results = reciprocalRankFusion(makeCandidates(), UNIFORM_WEIGHTS, 3);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it("method field is set", () => {
    const results = reciprocalRankFusion(makeCandidates(), UNIFORM_WEIGHTS, 3);
    expect(results[0].method).toBe("rrf");
  });
});

describe("geometricMeanFusion", () => {
  it("penalizes uneven scores", () => {
    const results = geometricMeanFusion(makeCandidates(), UNIFORM_WEIGHTS, 3);
    // Carol has uniform scores (0.6 everywhere), should benefit from geometric mean
    // Alice has one high (0.9) and one low (0.3), should be penalized
    expect(results[0].id).toBe("carol");
  });
});

describe("normalizeScores", () => {
  it("normalizes to [0, 1]", () => {
    const input = [
      {
        id: "a",
        score: 0.5,
        metadata: {},
        facetScores: { role: 0, industry: 0, expertise: 0, composite: 0 },
        method: "test",
      },
      {
        id: "b",
        score: 1.0,
        metadata: {},
        facetScores: { role: 0, industry: 0, expertise: 0, composite: 0 },
        method: "test",
      },
      {
        id: "c",
        score: 0.0,
        metadata: {},
        facetScores: { role: 0, industry: 0, expertise: 0, composite: 0 },
        method: "test",
      },
    ];
    const result = normalizeScores(input);
    expect(result[0].score).toBeCloseTo(0.5);
    expect(result[1].score).toBeCloseTo(1.0);
    expect(result[2].score).toBeCloseTo(0.0);
  });

  it("handles empty array", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("handles all same scores", () => {
    const input = [
      {
        id: "a",
        score: 0.5,
        metadata: {},
        facetScores: { role: 0, industry: 0, expertise: 0, composite: 0 },
        method: "test",
      },
      {
        id: "b",
        score: 0.5,
        metadata: {},
        facetScores: { role: 0, industry: 0, expertise: 0, composite: 0 },
        method: "test",
      },
    ];
    const result = normalizeScores(input);
    expect(result[0].score).toBe(1);
  });
});
