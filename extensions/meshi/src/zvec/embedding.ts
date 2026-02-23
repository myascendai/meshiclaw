/** Zvec — Embedding providers: Mistral API + offline hash-based fallback. */

import type { EmbeddingProvider } from "./types.js";

const MISTRAL_DIMENSIONS = 1024;
const MISTRAL_MODEL = "mistral-embed";
const MISTRAL_API_URL = "https://api.mistral.ai/v1/embeddings";

/**
 * Create a Mistral embedding provider.
 * Requires MISTRAL_API_KEY environment variable.
 */
export function createMistralProvider(apiKey?: string): EmbeddingProvider {
  const key = apiKey ?? process.env.MISTRAL_API_KEY;
  if (!key) {
    throw new Error("MISTRAL_API_KEY is required for Mistral embedding provider");
  }

  return {
    dimensions: MISTRAL_DIMENSIONS,
    async embed(text: string): Promise<Float32Array> {
      const response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          input: [text],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Mistral embedding failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = json.data?.[0]?.embedding;
      if (!embedding || embedding.length !== MISTRAL_DIMENSIONS) {
        throw new Error("Invalid embedding response from Mistral");
      }
      return new Float32Array(embedding);
    },
  };
}

/**
 * Hash-based pseudo-embedding for offline/testing use.
 * Produces deterministic vectors from text via a simple hash spread.
 * NOT suitable for real semantic search — only for testing and offline fallback.
 */
export function createHashProvider(dimensions = MISTRAL_DIMENSIONS): EmbeddingProvider {
  return {
    dimensions,
    async embed(text: string): Promise<Float32Array> {
      const vector = new Float32Array(dimensions);
      // Simple deterministic hash spread
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < dimensions; i++) {
        // Use a simple PRNG seeded from the text hash
        hash = ((hash * 1664525 + 1013904223) | 0) >>> 0;
        vector[i] = (hash / 0xffffffff) * 2 - 1; // Range [-1, 1]
      }
      // Normalize to unit vector
      let norm = 0;
      for (let i = 0; i < dimensions; i++) {
        norm += vector[i] * vector[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          vector[i] /= norm;
        }
      }
      return vector;
    },
  };
}

/**
 * Create an embedding provider with automatic fallback.
 * Uses Mistral if MISTRAL_API_KEY is available, otherwise falls back to hash-based.
 */
export function createEmbeddingProvider(apiKey?: string): EmbeddingProvider {
  const key = apiKey ?? process.env.MISTRAL_API_KEY;
  if (key) {
    return createMistralProvider(key);
  }
  return createHashProvider(MISTRAL_DIMENSIONS);
}
