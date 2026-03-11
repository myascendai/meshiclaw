import { resolve } from "node:path";
import { config } from "dotenv";
/**
 * Hyperparameter experiment for the zvec encoding algorithm.
 *
 * Tests multiple text composition strategies, facet weight configurations,
 * fusion methods, and measures quality via cluster separation, precision,
 * and ranking stability across the real 145-person dataset.
 *
 * Run: npx vitest run extensions/meshi/src/zvec/experiment.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";

config({ path: resolve(__dirname, "../../../../.env") });
config({ path: resolve(__dirname, "../../../../.env.local"), override: true });

import {
  createMeshiClient,
  searchContacts,
  type MeshiClient,
  type SearchContactResult,
} from "../supabase-client.js";
import { createEmbeddingProvider } from "./embedding.js";
import {
  weightedSumFusion,
  maxFacetFusion,
  reciprocalRankFusion,
  geometricMeanFusion,
  type FacetScore,
  type FusionMethod,
} from "./fusion.js";
import { MultiVectorStore } from "./multi-embedding.js";
import { analyzeQuery, WEIGHT_PRESETS, type FacetWeights } from "./query-analyzer.js";
import { cosineSimilarity } from "./similarity.js";
import { VectorStore } from "./store.js";
import {
  buildEmbeddingText,
  buildFacetTexts,
  expandTitle,
  extractIndustry,
  detectSeniority,
  type TextStrategy,
  type PersonFields,
} from "./text-enrichment.js";
import type { EmbeddingProvider } from "./types.js";

const SUPABASE_URL = process.env.MESHI_SUPABASE_URL!;
const SUPABASE_KEY = process.env.MESHI_SUPABASE_KEY!;
const PERSON_ID = "c24a3bca-cec2-40d4-9243-00f0595e523a";

const skip = !SUPABASE_URL || !SUPABASE_KEY || !process.env.MISTRAL_API_KEY;

// ---------------------------------------------------------------------------
// Test evaluation queries with expected "ground truth" categories
// ---------------------------------------------------------------------------

type EvalQuery = {
  query: string;
  /** Category we expect top results to belong to */
  expectedCategory: string;
  /** Keywords that should appear in relevant results' titles/headlines */
  relevanceKeywords: string[];
};

const EVAL_QUERIES: EvalQuery[] = [
  {
    query: "venture capital investor Latin America",
    expectedCategory: "VC/Investment",
    relevanceKeywords: ["investor", "venture", "capital", "fund", "partner", "vc", "investment"],
  },
  {
    query: "AI machine learning engineer",
    expectedCategory: "Engineering/AI",
    relevanceKeywords: [
      "engineer",
      "machine learning",
      "ai",
      "ml",
      "data",
      "scientist",
      "developer",
      "software",
    ],
  },
  {
    query: "fintech startup founder",
    expectedCategory: "Fintech/Founder",
    relevanceKeywords: [
      "fintech",
      "founder",
      "ceo",
      "co-founder",
      "financial",
      "payments",
      "banking",
    ],
  },
  {
    query: "product manager SaaS",
    expectedCategory: "Product",
    relevanceKeywords: ["product", "manager", "pm", "saas", "platform", "head of product"],
  },
  {
    query: "healthcare technology",
    expectedCategory: "Healthcare",
    relevanceKeywords: ["health", "medical", "biotech", "pharma", "healthcare", "clinical"],
  },
  {
    query: "pre-seed investor Mexico",
    expectedCategory: "VC/LatAm",
    relevanceKeywords: ["investor", "seed", "angel", "venture", "fund", "mexico", "latam"],
  },
];

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

/** Precision@K: fraction of top-K results matching relevance keywords. */
function precisionAtK(
  results: Array<{ metadata: Record<string, unknown> }>,
  keywords: string[],
  k: number,
): number {
  const topK = results.slice(0, k);
  let relevant = 0;
  for (const r of topK) {
    const text = [
      r.metadata.name as string,
      r.metadata.title as string,
      r.metadata.company as string,
      r.metadata.headline as string,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      relevant++;
    }
  }
  return topK.length > 0 ? relevant / topK.length : 0;
}

/**
 * Cluster separation: ratio of intra-cluster similarity to inter-cluster similarity.
 * Higher = better separation.
 */
function clusterSeparation(
  clusterA: Float32Array[],
  clusterB: Float32Array[],
): { intraA: number; intraB: number; inter: number; ratio: number } {
  const avgSim = (vecs: Float32Array[]): number => {
    if (vecs.length < 2) return 1;
    let total = 0;
    let count = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        total += cosineSimilarity(vecs[i], vecs[j]);
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  };

  const crossSim = (a: Float32Array[], b: Float32Array[]): number => {
    let total = 0;
    let count = 0;
    for (const va of a) {
      for (const vb of b) {
        total += cosineSimilarity(va, vb);
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  };

  const intraA = avgSim(clusterA);
  const intraB = avgSim(clusterB);
  const inter = crossSim(clusterA, clusterB);
  const avgIntra = (intraA + intraB) / 2;
  const ratio = inter > 0 ? avgIntra / inter : avgIntra > 0 ? Infinity : 1;

  return { intraA, intraB, inter, ratio };
}

/** NDCG@K: normalized discounted cumulative gain. */
function ndcgAtK(
  results: Array<{ metadata: Record<string, unknown> }>,
  keywords: string[],
  k: number,
): number {
  const topK = results.slice(0, k);

  const relevance = topK.map((r) => {
    const text = [
      r.metadata.name as string,
      r.metadata.title as string,
      r.metadata.company as string,
      r.metadata.headline as string,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matchCount = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
    return Math.min(matchCount, 3); // Cap relevance at 3
  });

  // DCG
  let dcg = 0;
  for (let i = 0; i < relevance.length; i++) {
    dcg += relevance[i] / Math.log2(i + 2);
  }

  // Ideal DCG (sort relevance descending)
  const ideal = [...relevance].sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) {
    idcg += ideal[i] / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

// ---------------------------------------------------------------------------
// Main experiment suite
// ---------------------------------------------------------------------------

describe.skipIf(skip)("Zvec Encoding Algorithm Experiments", () => {
  let client: MeshiClient;
  let provider: EmbeddingProvider;
  let allResults: SearchContactResult[];
  let personFields: Map<string, PersonFields>;

  beforeAll(async () => {
    client = createMeshiClient(SUPABASE_URL, SUPABASE_KEY, PERSON_ID);
    provider = createEmbeddingProvider();

    // Fetch diverse dataset
    const slices = [
      "VC",
      "AI",
      "fintech",
      "engineering",
      "product",
      "founder",
      "healthcare",
      "crypto",
    ];
    const seen = new Set<string>();
    allResults = [];

    for (const query of slices) {
      const results = await searchContacts(client, query, 30);
      for (const r of results) {
        if (!seen.has(r.to_person_id)) {
          seen.add(r.to_person_id);
          allResults.push(r);
        }
      }
    }

    personFields = new Map();
    for (const r of allResults) {
      personFields.set(r.to_person_id, {
        name: r.full_name,
        title: r.current_title,
        company: r.current_company,
        headline: r.headline,
      });
    }

    console.log(
      `\n  Dataset: ${allResults.length} unique people from ${slices.length} search slices`,
    );
  }, 60_000);

  // ------------------------------------------------------------------
  // Experiment 1: Text Composition Strategies
  // ------------------------------------------------------------------

  describe("Experiment 1: Text Composition Strategies", () => {
    const strategies: TextStrategy[] = [
      "naive",
      "structured",
      "expanded",
      "role_heavy",
      "industry_heavy",
      "composite",
    ];
    const strategyStores = new Map<TextStrategy, VectorStore>();

    beforeAll(async () => {
      for (const strategy of strategies) {
        const store = new VectorStore({ name: `exp-${strategy}`, dimensions: provider.dimensions });

        for (const r of allResults) {
          const fields: PersonFields = {
            name: r.full_name,
            title: r.current_title,
            company: r.current_company,
            headline: r.headline,
          };
          const text = buildEmbeddingText(fields, strategy);
          if (!text.trim()) continue;

          try {
            const vec = await provider.embed(text);
            store.upsert(r.to_person_id, vec, {
              name: r.full_name,
              title: r.current_title,
              company: r.current_company,
              headline: r.headline,
            });
          } catch {
            // skip
          }
        }

        strategyStores.set(strategy, store);
      }
      console.log(`  Built ${strategies.length} strategy stores`);
    }, 600_000);

    it("compares precision@5 across strategies", async () => {
      console.log("\n  Strategy Comparison — Precision@5 per query:");
      console.log("  " + "Query".padEnd(45) + strategies.map((s) => s.padStart(15)).join(""));
      console.log("  " + "-".repeat(45 + strategies.length * 15));

      const totals: Record<string, number> = {};
      for (const s of strategies) totals[s] = 0;

      for (const eq of EVAL_QUERIES) {
        const qVec = await provider.embed(eq.query);
        const row = [eq.query.slice(0, 43).padEnd(45)];

        for (const strategy of strategies) {
          const store = strategyStores.get(strategy)!;
          const results = store.search(qVec, 5);
          const p5 = precisionAtK(results, eq.relevanceKeywords, 5);
          totals[strategy] += p5;
          row.push(p5.toFixed(2).padStart(15));
        }

        console.log("  " + row.join(""));
      }

      // Average
      console.log("  " + "-".repeat(45 + strategies.length * 15));
      const avgRow = ["AVERAGE".padEnd(45)];
      for (const strategy of strategies) {
        const avg = totals[strategy] / EVAL_QUERIES.length;
        avgRow.push(avg.toFixed(2).padStart(15));
      }
      console.log("  " + avgRow.join(""));
    });

    it("compares NDCG@5 across strategies", async () => {
      console.log("\n  Strategy Comparison — NDCG@5 per query:");
      console.log("  " + "Query".padEnd(45) + strategies.map((s) => s.padStart(15)).join(""));
      console.log("  " + "-".repeat(45 + strategies.length * 15));

      const totals: Record<string, number> = {};
      for (const s of strategies) totals[s] = 0;

      for (const eq of EVAL_QUERIES) {
        const qVec = await provider.embed(eq.query);
        const row = [eq.query.slice(0, 43).padEnd(45)];

        for (const strategy of strategies) {
          const store = strategyStores.get(strategy)!;
          const results = store.search(qVec, 5);
          const n5 = ndcgAtK(results, eq.relevanceKeywords, 5);
          totals[strategy] += n5;
          row.push(n5.toFixed(2).padStart(15));
        }

        console.log("  " + row.join(""));
      }

      console.log("  " + "-".repeat(45 + strategies.length * 15));
      const avgRow = ["AVERAGE".padEnd(45)];
      for (const strategy of strategies) {
        const avg = totals[strategy] / EVAL_QUERIES.length;
        avgRow.push(avg.toFixed(2).padStart(15));
      }
      console.log("  " + avgRow.join(""));
    });

    it("measures cluster separation: VC vs Engineers", async () => {
      console.log("\n  Cluster Separation (VC vs Engineer):");
      console.log(
        "  " +
          "Strategy".padEnd(20) +
          "Intra-VC".padStart(12) +
          "Intra-Eng".padStart(12) +
          "Inter".padStart(12) +
          "Ratio".padStart(12),
      );

      for (const strategy of strategies) {
        const store = strategyStores.get(strategy)!;
        const qVc = await provider.embed("venture capital investor fund partner");
        const qEng = await provider.embed("software engineer developer programming");

        const vcResults = store.search(qVc, 8);
        const engResults = store.search(qEng, 8);

        const vcVecs = vcResults.map((r) => store.get(r.id)!.vector);
        const engVecs = engResults.map((r) => store.get(r.id)!.vector);

        const sep = clusterSeparation(vcVecs, engVecs);

        console.log(
          "  " +
            strategy.padEnd(20) +
            sep.intraA.toFixed(3).padStart(12) +
            sep.intraB.toFixed(3).padStart(12) +
            sep.inter.toFixed(3).padStart(12) +
            sep.ratio.toFixed(3).padStart(12),
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // Experiment 2: Multi-Facet Embeddings vs Single Vector
  // ------------------------------------------------------------------

  describe("Experiment 2: Multi-Facet vs Single Vector", () => {
    let multiStore: MultiVectorStore;
    let singleStore: VectorStore;

    beforeAll(async () => {
      // Build multi-facet store
      multiStore = new MultiVectorStore({ name: "exp-multi", dimensions: provider.dimensions });

      for (const r of allResults) {
        const fields: PersonFields = {
          name: r.full_name,
          title: r.current_title,
          company: r.current_company,
          headline: r.headline,
        };
        try {
          await multiStore.upsertPerson(r.to_person_id, fields, provider, {
            db_mutual_fit_score: r.mutual_fit_score,
          });
        } catch {
          // skip
        }
      }

      // Build single-vector store (composite strategy, best from Exp 1 or default)
      singleStore = new VectorStore({
        name: "exp-single-composite",
        dimensions: provider.dimensions,
      });
      for (const r of allResults) {
        const fields: PersonFields = {
          name: r.full_name,
          title: r.current_title,
          company: r.current_company,
          headline: r.headline,
        };
        const text = buildEmbeddingText(fields, "composite");
        if (!text.trim()) continue;
        try {
          const vec = await provider.embed(text);
          singleStore.upsert(r.to_person_id, vec, {
            name: r.full_name,
            title: r.current_title,
            company: r.current_company,
            headline: r.headline,
          });
        } catch {}
      }

      console.log(`  Multi-facet store: ${multiStore.size} people (4 vectors each)`);
      console.log(`  Single-vector store: ${singleStore.size} people`);
    }, 600_000);

    it("compares multi-facet (weighted sum) vs single vector", async () => {
      console.log("\n  Multi-Facet (weighted_sum, adaptive) vs Single Vector:");
      console.log(
        "  " +
          "Query".padEnd(45) +
          "Multi-P@5".padStart(12) +
          "Single-P@5".padStart(12) +
          "Delta".padStart(10),
      );

      let multiTotal = 0;
      let singleTotal = 0;

      for (const eq of EVAL_QUERIES) {
        const multiResults = await multiStore.search(eq.query, provider, 5, {
          method: "weighted_sum",
          adaptiveWeights: true,
        });
        const multiP5 = precisionAtK(multiResults, eq.relevanceKeywords, 5);

        const singleVec = await provider.embed(eq.query);
        const singleResults = singleStore.search(singleVec, 5);
        const singleP5 = precisionAtK(singleResults, eq.relevanceKeywords, 5);

        const delta = multiP5 - singleP5;
        multiTotal += multiP5;
        singleTotal += singleP5;

        console.log(
          "  " +
            eq.query.slice(0, 43).padEnd(45) +
            multiP5.toFixed(2).padStart(12) +
            singleP5.toFixed(2).padStart(12) +
            (delta >= 0 ? "+" : "") +
            delta.toFixed(2).padStart(9),
        );
      }

      const n = EVAL_QUERIES.length;
      const multiAvg = multiTotal / n;
      const singleAvg = singleTotal / n;
      console.log("  " + "-".repeat(45 + 34));
      console.log(
        "  " +
          "AVERAGE".padEnd(45) +
          multiAvg.toFixed(2).padStart(12) +
          singleAvg.toFixed(2).padStart(12) +
          ((multiAvg - singleAvg >= 0 ? "+" : "") + (multiAvg - singleAvg).toFixed(2)).padStart(9),
      );
    });

    it("compares all fusion methods", async () => {
      const methods: FusionMethod[] = ["weighted_sum", "max_facet", "rrf", "geometric_mean"];

      console.log("\n  Fusion Method Comparison — avg Precision@5:");
      console.log(
        "  " +
          "Method".padEnd(20) +
          EVAL_QUERIES.map((q) => q.expectedCategory.slice(0, 12).padStart(14)).join("") +
          "AVG".padStart(10),
      );

      for (const method of methods) {
        const row = [method.padEnd(20)];
        let total = 0;

        for (const eq of EVAL_QUERIES) {
          const results = await multiStore.search(eq.query, provider, 5, {
            method,
            adaptiveWeights: true,
          });
          const p5 = precisionAtK(results, eq.relevanceKeywords, 5);
          total += p5;
          row.push(p5.toFixed(2).padStart(14));
        }

        row.push((total / EVAL_QUERIES.length).toFixed(2).padStart(10));
        console.log("  " + row.join(""));
      }
    });

    it("tests weight presets", async () => {
      const presetNames = Object.keys(WEIGHT_PRESETS);

      console.log("\n  Weight Preset Comparison — avg Precision@5:");
      console.log(
        "  " +
          "Preset".padEnd(22) +
          EVAL_QUERIES.map((q) => q.expectedCategory.slice(0, 12).padStart(14)).join("") +
          "AVG".padStart(10),
      );

      let bestPreset = "";
      let bestAvg = 0;

      for (const presetName of presetNames) {
        const weights = WEIGHT_PRESETS[presetName];
        const row = [presetName.padEnd(22)];
        let total = 0;

        for (const eq of EVAL_QUERIES) {
          const results = await multiStore.search(eq.query, provider, 5, {
            weights,
            method: "weighted_sum",
            adaptiveWeights: false,
          });
          const p5 = precisionAtK(results, eq.relevanceKeywords, 5);
          total += p5;
          row.push(p5.toFixed(2).padStart(14));
        }

        const avg = total / EVAL_QUERIES.length;
        row.push(avg.toFixed(2).padStart(10));
        console.log("  " + row.join(""));

        if (avg > bestAvg) {
          bestAvg = avg;
          bestPreset = presetName;
        }
      }

      // Also test adaptive
      const row = ["adaptive".padEnd(22)];
      let total = 0;
      for (const eq of EVAL_QUERIES) {
        const results = await multiStore.search(eq.query, provider, 5, {
          method: "weighted_sum",
          adaptiveWeights: true,
        });
        const p5 = precisionAtK(results, eq.relevanceKeywords, 5);
        total += p5;
        row.push(p5.toFixed(2).padStart(14));
      }
      const adaptiveAvg = total / EVAL_QUERIES.length;
      row.push(adaptiveAvg.toFixed(2).padStart(10));
      console.log("  " + row.join(""));

      console.log(`\n  Best static preset: ${bestPreset} (avg P@5 = ${bestAvg.toFixed(2)})`);
      console.log(`  Adaptive weights avg P@5 = ${adaptiveAvg.toFixed(2)}`);
    });

    it("facet score breakdown per query", async () => {
      console.log("\n  Facet Score Breakdown (top-3 per query):");

      for (const eq of EVAL_QUERIES) {
        const results = await multiStore.search(eq.query, provider, 3, {
          method: "weighted_sum",
          adaptiveWeights: true,
        });

        const analysis = analyzeQuery(eq.query);
        console.log(
          `\n  Query: "${eq.query}" (intent: ${analysis.intent}, conf: ${analysis.confidence.toFixed(2)})`,
        );
        console.log(
          `  Weights: role=${analysis.weights.role.toFixed(2)} ind=${analysis.weights.industry.toFixed(2)} exp=${analysis.weights.expertise.toFixed(2)} comp=${analysis.weights.composite.toFixed(2)}`,
        );
        console.log(
          "  " +
            "Name".padEnd(30) +
            "Fused".padStart(8) +
            "Role".padStart(8) +
            "Indst".padStart(8) +
            "Expert".padStart(8) +
            "Comps".padStart(8),
        );

        for (const r of results) {
          console.log(
            "  " +
              (r.metadata.name as string).slice(0, 28).padEnd(30) +
              r.score.toFixed(3).padStart(8) +
              r.facetScores.role.toFixed(3).padStart(8) +
              r.facetScores.industry.toFixed(3).padStart(8) +
              r.facetScores.expertise.toFixed(3).padStart(8) +
              r.facetScores.composite.toFixed(3).padStart(8),
          );
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // Experiment 3: Query Analysis Quality
  // ------------------------------------------------------------------

  describe("Experiment 3: Query Analysis", () => {
    it("validates intent detection accuracy", () => {
      const testCases: Array<{ query: string; expected: string }> = [
        { query: "software engineer AI", expected: "role" },
        { query: "venture capital investor", expected: "role" }, // "investor" is a role
        { query: "fintech payments company", expected: "industry" },
        { query: "healthcare biotech", expected: "industry" },
        { query: "python machine learning tensorflow", expected: "skill" },
        { query: "Mexico startup ecosystem", expected: "location" },
        { query: "someone interesting to talk to", expected: "general" },
        { query: "founder CEO early stage", expected: "role" },
      ];

      console.log("\n  Query Intent Detection:");
      console.log(
        "  " +
          "Query".padEnd(45) +
          "Detected".padStart(15) +
          "Expected".padStart(15) +
          "Match".padStart(8),
      );

      let correct = 0;
      for (const tc of testCases) {
        const analysis = analyzeQuery(tc.query);
        const match = analysis.intent === tc.expected;
        if (match) correct++;
        console.log(
          "  " +
            tc.query.padEnd(45) +
            analysis.intent.padStart(15) +
            tc.expected.padStart(15) +
            (match ? "  yes" : "  NO").padStart(8),
        );
      }

      const accuracy = correct / testCases.length;
      console.log(
        `\n  Intent accuracy: ${correct}/${testCases.length} (${(accuracy * 100).toFixed(0)}%)`,
      );
      expect(accuracy).toBeGreaterThanOrEqual(0.5); // At least 50% correct
    });
  });

  // ------------------------------------------------------------------
  // Experiment 4: Text Enrichment Quality
  // ------------------------------------------------------------------

  describe("Experiment 4: Text Enrichment", () => {
    it("validates title expansion", () => {
      const cases = [
        { input: "CEO", expanded: true },
        { input: "CTO at Startup", expanded: true },
        { input: "VP of Engineering", expanded: true },
        { input: "Software Engineer", expanded: false },
        { input: "ML Engineer", expanded: true },
        { input: "Product Manager", expanded: false },
      ];

      console.log("\n  Title Expansion:");
      for (const c of cases) {
        const result = expandTitle(c.input);
        const didExpand = result.length > c.input.length;
        console.log(`  ${c.input.padEnd(30)} → ${result.slice(0, 70)}`);
        if (c.expanded) {
          expect(didExpand).toBe(true);
        }
      }
    });

    it("validates industry extraction", () => {
      const cases = [
        { input: "VP Engineering at fintech startup", expected: ["fintech"] },
        {
          input: "AI researcher at biotech lab",
          expected: ["artificial intelligence", "healthcare"],
        },
        { input: "Managing Partner at VC fund", expected: ["venture capital"] },
        { input: "Baker at local bakery", expected: [] },
      ];

      console.log("\n  Industry Extraction:");
      for (const c of cases) {
        const result = extractIndustry(c.input);
        console.log(`  "${c.input}" → [${result.join(", ")}]`);
        for (const exp of c.expected) {
          expect(result.some((r) => r.toLowerCase().includes(exp.toLowerCase()))).toBe(true);
        }
      }
    });

    it("validates seniority detection", () => {
      const cases = [
        { input: "CEO", expected: "executive" },
        { input: "Co-Founder & CTO", expected: "founder" },
        { input: "VP Engineering", expected: "senior leadership" },
        { input: "Senior Software Engineer", expected: "senior" },
        { input: "Product Manager", expected: "mid-level" },
        { input: "Analyst", expected: "early career" },
      ];

      console.log("\n  Seniority Detection:");
      for (const c of cases) {
        const result = detectSeniority(c.input);
        console.log(`  "${c.input}" → ${result}`);
        expect(result).toBe(c.expected);
      }
    });

    it("shows facet text examples from real data", () => {
      console.log("\n  Facet Text Examples (first 5 people):");

      for (const r of allResults.slice(0, 5)) {
        const fields: PersonFields = {
          name: r.full_name,
          title: r.current_title,
          company: r.current_company,
          headline: r.headline,
        };
        const facets = buildFacetTexts(fields);

        console.log(`\n  ${r.full_name}:`);
        console.log(`    Role:      ${facets.role.slice(0, 90)}`);
        console.log(`    Industry:  ${facets.industry.slice(0, 90)}`);
        console.log(`    Expertise: ${facets.expertise.slice(0, 90)}`);
        console.log(`    Composite: ${facets.composite.slice(0, 90)}`);
      }
    });
  });

  // ------------------------------------------------------------------
  // Experiment 5: Score Distribution Analysis
  // ------------------------------------------------------------------

  describe("Experiment 5: Score Distribution", () => {
    it("analyzes score spread and discrimination", async () => {
      const multiStore = new MultiVectorStore({
        name: "exp-dist",
        dimensions: provider.dimensions,
      });

      // Use a subset for speed
      const subset = allResults.slice(0, 50);
      for (const r of subset) {
        const fields: PersonFields = {
          name: r.full_name,
          title: r.current_title,
          company: r.current_company,
          headline: r.headline,
        };
        try {
          await multiStore.upsertPerson(r.to_person_id, fields, provider);
        } catch {}
      }

      const queries = ["venture capital investor", "software engineer", "fintech founder"];

      console.log("\n  Score Distribution Analysis:");

      for (const q of queries) {
        const results = await multiStore.search(q, provider, multiStore.size, {
          method: "weighted_sum",
          adaptiveWeights: true,
        });

        const scores = results.map((r) => r.score);
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
        const std = Math.sqrt(variance);
        const min = Math.min(...scores);
        const max = Math.max(...scores);

        // Score at various percentiles
        const p10 = scores[Math.floor(scores.length * 0.1)] ?? 0;
        const p25 = scores[Math.floor(scores.length * 0.25)] ?? 0;
        const p50 = scores[Math.floor(scores.length * 0.5)] ?? 0;
        const p75 = scores[Math.floor(scores.length * 0.75)] ?? 0;
        const p90 = scores[Math.floor(scores.length * 0.9)] ?? 0;

        console.log(`\n  Query: "${q}" (n=${scores.length})`);
        console.log(
          `    Mean=${mean.toFixed(3)}  Std=${std.toFixed(3)}  Min=${min.toFixed(3)}  Max=${max.toFixed(3)}`,
        );
        console.log(
          `    P10=${p10.toFixed(3)}  P25=${p25.toFixed(3)}  P50=${p50.toFixed(3)}  P75=${p75.toFixed(3)}  P90=${p90.toFixed(3)}`,
        );
        console.log(
          `    Discrimination (max-min)=${(max - min).toFixed(3)}  CV=${(std / mean).toFixed(3)}`,
        );

        // Good embeddings should have: high discrimination, reasonable spread
        expect(max - min).toBeGreaterThan(0.05); // At least some discrimination
      }
    }, 300_000);
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  describe("Experiment Summary", () => {
    it("prints recommendations", () => {
      console.log("\n  ════════════════════════════════════════════════════════════");
      console.log("  EXPERIMENT SUMMARY");
      console.log("  ════════════════════════════════════════════════════════════");
      console.log("  ");
      console.log("  Key findings from the experiments above:");
      console.log("  1. Text composition: Compare P@5 averages to find best strategy");
      console.log("  2. Multi-facet: Check if multi-facet outperforms single-vector");
      console.log("  3. Fusion methods: RRF is usually most robust; weighted_sum more tunable");
      console.log("  4. Adaptive weights: Check if query-adaptive beats uniform/static");
      console.log("  5. Score distribution: Higher CV means better discrimination");
      console.log("  ");
      console.log("  Read the tables above to determine optimal configuration.");
      console.log("  ════════════════════════════════════════════════════════════");
    });
  });
});
