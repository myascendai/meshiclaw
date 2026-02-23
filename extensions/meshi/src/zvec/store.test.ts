import { describe, it, expect, beforeEach } from "vitest";
import { createHashProvider } from "./embedding.js";
import { cosineSimilarity } from "./similarity.js";
import { VectorStore } from "./store.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1);
  });

  it("throws on dimension mismatch", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow("dimension mismatch");
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore({ name: "test", dimensions: 3 });
  });

  it("starts empty", () => {
    expect(store.size).toBe(0);
  });

  it("upserts and retrieves entries", () => {
    store.upsert("a", new Float32Array([1, 0, 0]), { name: "Alice" });
    expect(store.size).toBe(1);
    expect(store.has("a")).toBe(true);
    expect(store.get("a")?.metadata.name).toBe("Alice");
  });

  it("overwrites on duplicate upsert", () => {
    store.upsert("a", new Float32Array([1, 0, 0]), { name: "Alice" });
    store.upsert("a", new Float32Array([0, 1, 0]), { name: "Alice Updated" });
    expect(store.size).toBe(1);
    expect(store.get("a")?.metadata.name).toBe("Alice Updated");
  });

  it("deletes entries", () => {
    store.upsert("a", new Float32Array([1, 0, 0]));
    expect(store.delete("a")).toBe(true);
    expect(store.size).toBe(0);
    expect(store.delete("a")).toBe(false);
  });

  it("throws on dimension mismatch during upsert", () => {
    expect(() => store.upsert("a", new Float32Array([1, 0]))).toThrow("dimension mismatch");
  });

  it("searches and returns results sorted by score", () => {
    store.upsert("a", new Float32Array([1, 0, 0]), { name: "Alice" });
    store.upsert("b", new Float32Array([0.9, 0.1, 0]), { name: "Bob" });
    store.upsert("c", new Float32Array([0, 1, 0]), { name: "Carol" });

    const results = store.search(new Float32Array([1, 0, 0]), 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeCloseTo(1);
    expect(results[1].id).toBe("b");
    expect(results[1].metadata.name).toBe("Bob");
  });

  it("limits results to topK", () => {
    for (let i = 0; i < 20; i++) {
      const vec = new Float32Array(3);
      vec[0] = Math.random();
      vec[1] = Math.random();
      vec[2] = Math.random();
      store.upsert(`entry-${i}`, vec);
    }
    const results = store.search(new Float32Array([1, 0, 0]), 5);
    expect(results).toHaveLength(5);
  });

  it("clears all entries", () => {
    store.upsert("a", new Float32Array([1, 0, 0]));
    store.upsert("b", new Float32Array([0, 1, 0]));
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("createHashProvider", () => {
  it("produces deterministic embeddings", async () => {
    const provider = createHashProvider(64);
    const a = await provider.embed("hello world");
    const b = await provider.embed("hello world");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different embeddings for different text", async () => {
    const provider = createHashProvider(64);
    const a = await provider.embed("hello");
    const b = await provider.embed("world");
    const sim = cosineSimilarity(a, b);
    expect(Math.abs(sim)).toBeLessThan(0.99);
  });

  it("produces unit vectors", async () => {
    const provider = createHashProvider(128);
    const vec = await provider.embed("test input");
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
  });

  it("respects custom dimensions", async () => {
    const provider = createHashProvider(256);
    expect(provider.dimensions).toBe(256);
    const vec = await provider.embed("test");
    expect(vec.length).toBe(256);
  });
});
