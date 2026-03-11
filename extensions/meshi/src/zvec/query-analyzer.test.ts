import { describe, it, expect } from "vitest";
import { analyzeQuery, WEIGHT_PRESETS } from "./query-analyzer.js";

describe("analyzeQuery", () => {
  it("detects role intent", () => {
    const result = analyzeQuery("software engineer AI");
    expect(result.intent).toBe("role");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.weights.role).toBeGreaterThan(result.weights.industry);
  });

  it("detects industry intent", () => {
    const result = analyzeQuery("fintech payments company");
    expect(result.intent).toBe("industry");
    expect(result.weights.industry).toBeGreaterThan(result.weights.role);
  });

  it("detects skill intent", () => {
    const result = analyzeQuery("python machine learning tensorflow");
    expect(result.intent).toBe("skill");
    expect(result.weights.expertise).toBeGreaterThan(result.weights.role);
  });

  it("detects location intent", () => {
    const result = analyzeQuery("Mexico startup ecosystem");
    expect(result.intent).toBe("location");
  });

  it("falls back to general", () => {
    const result = analyzeQuery("someone interesting to talk to");
    expect(result.intent).toBe("general");
  });

  it("generates expanded query", () => {
    const result = analyzeQuery("vc investor latam");
    expect(result.expandedQuery).toContain("venture capital");
    expect(result.expandedQuery).toContain("Latin America");
  });

  it("weights always sum close to 1", () => {
    const queries = [
      "software engineer",
      "fintech startup",
      "python expert",
      "Mexico VC",
      "general person",
    ];
    for (const q of queries) {
      const { weights } = analyzeQuery(q);
      const sum = weights.role + weights.industry + weights.expertise + weights.composite;
      expect(sum).toBeCloseTo(1, 1);
    }
  });
});

describe("WEIGHT_PRESETS", () => {
  it("all presets sum to 1", () => {
    for (const [name, weights] of Object.entries(WEIGHT_PRESETS)) {
      const sum = weights.role + weights.industry + weights.expertise + weights.composite;
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it("has expected presets", () => {
    expect(WEIGHT_PRESETS).toHaveProperty("uniform");
    expect(WEIGHT_PRESETS).toHaveProperty("role_focused");
    expect(WEIGHT_PRESETS).toHaveProperty("industry_focused");
    expect(WEIGHT_PRESETS).toHaveProperty("expertise_focused");
  });
});
