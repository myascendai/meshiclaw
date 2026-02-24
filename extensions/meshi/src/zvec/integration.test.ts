import { resolve } from "node:path";
import { config } from "dotenv";
/**
 * Integration test for the zvec sync + search pipeline.
 * Connects to real Supabase + Mistral embeddings to verify end-to-end data flow.
 *
 * Run: npx vitest run extensions/meshi/src/zvec/integration.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";

// Load env from project root
config({ path: resolve(__dirname, "../../../../.env") });
config({ path: resolve(__dirname, "../../../../.env.local"), override: true });

import {
  createMeshiClient,
  searchContacts,
  getContacts,
  listContactsDirect,
  type MeshiClient,
  type SearchContactResult,
} from "../supabase-client.js";
import { createEmbeddingProvider, createHashProvider } from "./embedding.js";
import { cosineSimilarity } from "./similarity.js";
import { VectorStore } from "./store.js";
import type { EmbeddingProvider } from "./types.js";

const SUPABASE_URL = process.env.MESHI_SUPABASE_URL!;
const SUPABASE_KEY = process.env.MESHI_SUPABASE_KEY!;
const PERSON_ID = "c24a3bca-cec2-40d4-9243-00f0595e523a";

const skip = !SUPABASE_URL || !SUPABASE_KEY;

describe.skipIf(skip)("Meshi + Zvec integration", () => {
  let client: MeshiClient;
  let provider: EmbeddingProvider;
  let usingMistral: boolean;

  beforeAll(() => {
    client = createMeshiClient(SUPABASE_URL, SUPABASE_KEY, PERSON_ID);
    provider = createEmbeddingProvider();
    usingMistral = !!process.env.MISTRAL_API_KEY;
    console.log(
      `  Embedding provider: ${usingMistral ? "Mistral (mistral-embed)" : "Hash fallback"}`,
    );
  });

  // ------------------------------------------------------------------
  // 1. Data access sanity checks
  // ------------------------------------------------------------------

  describe("Supabase data access", () => {
    it("searchContacts returns results for broad queries", async () => {
      const queries = ["VC", "AI", "fintech", "engineering"];
      for (const q of queries) {
        const results = await searchContacts(client, q, 5);
        console.log(`  search("${q}"): ${results.length} results`);
        for (const r of results.slice(0, 2)) {
          console.log(
            `    - ${r.full_name} | ${r.current_title ?? ""} @ ${r.current_company ?? ""}`,
          );
        }
      }
    });

    it("getContacts reports contact graph status", async () => {
      const contacts = await getContacts(client, { limit: 10 });
      console.log(`  Contact graph: ${contacts.length} connections`);
      if (contacts.length === 0) {
        console.log("  → Graph empty — meshi_sync_from_search is the path.");
      }
    });
  });

  // ------------------------------------------------------------------
  // 2. Build a real index with Mistral embeddings + rich metadata
  // ------------------------------------------------------------------

  describe("Zvec index with Mistral embeddings", () => {
    let store: VectorStore;
    let allResults: SearchContactResult[];

    beforeAll(async () => {
      store = new VectorStore({ name: "integration-mistral", dimensions: provider.dimensions });

      // Pull from multiple search slices to get diverse data
      const slices = ["VC", "AI", "fintech", "engineering", "product", "founder"];
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
      console.log(
        `  Fetched ${allResults.length} unique people from ${slices.length} search slices`,
      );
    });

    it("indexes people with rich metadata", async () => {
      let indexed = 0;
      for (const r of allResults) {
        // Build embedding text from all available fields
        const embeddingText = [r.full_name, r.current_title, r.current_company, r.headline]
          .filter(Boolean)
          .join(" — ");
        if (!embeddingText.trim()) continue;

        try {
          const vec = await provider.embed(embeddingText);
          store.upsert(r.to_person_id, vec, {
            // Identity
            name: r.full_name,
            title: r.current_title,
            company: r.current_company,
            headline: r.headline,
            // DB scores (for comparison with local scoring)
            db_mutual_fit_score: r.mutual_fit_score,
            db_similarity_score: r.similarity_score,
            db_complementarity_score: r.complementarity_score,
            // Embedding metadata
            embedding_text: embeddingText,
            indexed_at: Date.now(),
          });
          indexed++;
        } catch (err) {
          console.log(`  ⚠ Failed to embed: ${r.full_name}: ${err}`);
        }
      }

      console.log(`  Indexed: ${indexed}/${allResults.length} people`);
      console.log(`  Store size: ${store.size}`);
      expect(indexed).toBeGreaterThan(0);
    });

    it("semantic search returns meaningful rankings", async () => {
      if (store.size === 0) return;

      const queries = [
        "venture capital investor Latin America",
        "AI machine learning engineer",
        "fintech startup founder",
        "product manager SaaS",
        "healthcare technology",
        "pre-seed investor Mexico",
      ];

      for (const q of queries) {
        const qVec = await provider.embed(q);
        const results = store.search(qVec, 5);
        console.log(`\n  search("${q}"):`);
        for (const r of results) {
          const score = r.score.toFixed(3);
          const dbFit = r.metadata.db_mutual_fit_score;
          const fitStr = dbFit != null ? ` | db_fit=${(dbFit as number).toFixed(2)}` : "";
          console.log(
            `    ${score} — ${r.metadata.name} | ${r.metadata.title ?? ""} @ ${r.metadata.company ?? ""}${fitStr}`,
          );
        }
      }
    });

    it("measures embedding quality: similar roles cluster together", async () => {
      if (store.size < 5) return;

      // Pick two contrasting reference queries
      const vcVec = await provider.embed("venture capital investor fund partner");
      const engVec = await provider.embed("software engineer developer programming");

      const vcResults = store.search(vcVec, 5);
      const engResults = store.search(engVec, 5);

      console.log("\n  Cluster analysis:");
      console.log("  VC/Investor cluster (top 5):");
      for (const r of vcResults) {
        console.log(`    ${r.score.toFixed(3)} — ${r.metadata.name} | ${r.metadata.title ?? ""}`);
      }
      console.log("  Engineer cluster (top 5):");
      for (const r of engResults) {
        console.log(`    ${r.score.toFixed(3)} — ${r.metadata.name} | ${r.metadata.title ?? ""}`);
      }

      if (usingMistral) {
        // With real embeddings, VC query should score higher for VC-titled people
        const vcTopScore = vcResults[0]?.score ?? 0;
        const engTopScore = engResults[0]?.score ?? 0;
        console.log(`\n  VC top score: ${vcTopScore.toFixed(3)}`);
        console.log(`  Eng top score: ${engTopScore.toFixed(3)}`);
        // Both should have meaningful similarity (> 0.3 with Mistral)
        expect(vcTopScore).toBeGreaterThan(0.2);
        expect(engTopScore).toBeGreaterThan(0.2);
      }
    });

    it("cross-similarity matrix: comparing people to each other", async () => {
      if (store.size < 4) return;

      // Pick 4 diverse people from the store
      const entries = Array.from({ length: Math.min(store.size, 8) }, (_, i) => {
        const results = store.search(
          // Use their own vector as the query to get them + neighbors
          store.get(allResults[i]?.to_person_id ?? "")?.vector ??
            new Float32Array(provider.dimensions),
          1,
        );
        return results[0];
      })
        .filter(Boolean)
        .slice(0, 4);

      if (entries.length < 4) return;

      console.log("\n  Cross-similarity (how similar are these people to each other):");
      const names = entries.map((e) => (e.metadata.name as string).slice(0, 20).padEnd(20));
      console.log("  " + " ".repeat(22) + names.join(" "));

      for (let i = 0; i < entries.length; i++) {
        const row: string[] = [];
        const personVec = store.get(entries[i].id)!.vector;
        for (let j = 0; j < entries.length; j++) {
          const otherVec = store.get(entries[j].id)!.vector;
          const sim = cosineSimilarity(personVec, otherVec);
          row.push(sim.toFixed(2).padStart(20));
        }
        console.log(`  ${names[i]} ${row.join(" ")}`);
      }
    });

    it("persists the full index to disk", async () => {
      if (store.size === 0) return;

      await store.save();

      // Verify round-trip
      const store2 = new VectorStore({
        name: "integration-mistral",
        dimensions: provider.dimensions,
      });
      await store2.load();

      expect(store2.size).toBe(store.size);
      console.log(
        `\n  Persisted ${store.size} entries to ~/.openclaw/zvec/integration-mistral.jsonl`,
      );

      // Spot-check vector fidelity
      const firstId = allResults[0]?.to_person_id;
      if (firstId && store.has(firstId) && store2.has(firstId)) {
        const sim = cosineSimilarity(store.get(firstId)!.vector, store2.get(firstId)!.vector);
        console.log(`  Vector fidelity check: ${sim.toFixed(6)}`);
        expect(sim).toBeCloseTo(1.0, 4);
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. Explore: local embeddings vs DB mutual_fit_score
  // ------------------------------------------------------------------

  describe("Embedding similarity vs DB mutual_fit_score comparison", () => {
    it("compares embedding-based ranking to DB fit scores", async () => {
      // This test explores the gap between embedding similarity and the
      // current DB mutual_fit_score — useful for evolving the algorithm.

      const store = new VectorStore({
        name: "integration-mistral",
        dimensions: provider.dimensions,
      });
      try {
        await store.load();
      } catch {
        console.log("  ⚠ No persisted store found — run the indexing test first");
        return;
      }

      if (store.size < 5) {
        console.log("  ⚠ Store too small for comparison");
        return;
      }

      // Query and compare rankings
      const query = "venture capital early stage startup investor";
      const qVec = await provider.embed(query);
      const results = store.search(qVec, 10);

      console.log(`\n  Query: "${query}"`);
      console.log("  Rank | Embed Score | DB Fit  | Name / Title / Company");
      console.log("  " + "-".repeat(80));

      const withDbFit: Array<{
        rank: number;
        embedScore: number;
        dbFit: number | null;
        name: string;
        detail: string;
      }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dbFit = r.metadata.db_mutual_fit_score as number | null;
        const detail = `${r.metadata.title ?? ""} @ ${r.metadata.company ?? ""}`;
        console.log(
          `  #${(i + 1).toString().padStart(2)} | ${r.score.toFixed(3).padStart(10)} | ${dbFit != null ? dbFit.toFixed(2).padStart(6) : "  n/a "} | ${r.metadata.name} — ${detail}`,
        );
        withDbFit.push({
          rank: i + 1,
          embedScore: r.score,
          dbFit,
          name: r.metadata.name as string,
          detail,
        });
      }

      // Calculate rank correlation if we have DB fit scores
      const scored = withDbFit.filter((r) => r.dbFit != null);
      if (scored.length >= 3) {
        // Sort by DB fit and compare to embedding rank
        const byDbFit = [...scored].sort((a, b) => (b.dbFit ?? 0) - (a.dbFit ?? 0));
        console.log("\n  Re-ranked by DB mutual_fit_score:");
        for (let i = 0; i < byDbFit.length; i++) {
          const r = byDbFit[i];
          console.log(
            `  #${(i + 1).toString().padStart(2)} (was #${r.rank.toString().padStart(2)}) | fit=${r.dbFit!.toFixed(2)} | embed=${r.embedScore.toFixed(3)} | ${r.name}`,
          );
        }

        // Spearman rank correlation (rough)
        const n = scored.length;
        const embedRanks = scored.map((_, i) => i + 1);
        const dbFitRanks = scored.map((r) => {
          return byDbFit.findIndex((b) => b.name === r.name) + 1;
        });
        let d2sum = 0;
        for (let i = 0; i < n; i++) {
          d2sum += (embedRanks[i] - dbFitRanks[i]) ** 2;
        }
        const spearman = 1 - (6 * d2sum) / (n * (n * n - 1));
        console.log(`\n  Spearman rank correlation (embed vs db_fit): ${spearman.toFixed(3)}`);
        console.log(
          `  → ${spearman > 0.5 ? "Rankings broadly agree" : spearman > 0 ? "Weak agreement — embeddings capture different signal" : "Rankings diverge — embeddings and DB fit measure different things"}`,
        );
      } else {
        console.log("\n  ⚠ Not enough DB fit scores to compute rank correlation");
      }
    });
  });
});
