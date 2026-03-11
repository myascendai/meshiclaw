import { describe, it, expect } from "vitest";
import {
  expandTitle,
  extractIndustry,
  detectSeniority,
  buildFacetTexts,
  buildEmbeddingText,
} from "./text-enrichment.js";

describe("expandTitle", () => {
  it("expands CEO", () => {
    const result = expandTitle("CEO");
    expect(result).toContain("chief executive officer");
  });

  it("expands CTO in context", () => {
    const result = expandTitle("CTO at Startup");
    expect(result).toContain("chief technology officer");
  });

  it("expands VP", () => {
    const result = expandTitle("VP of Engineering");
    expect(result).toContain("vice president");
  });

  it("does not expand normal titles", () => {
    const result = expandTitle("Software Engineer");
    expect(result).toBe("Software Engineer");
  });

  it("handles empty string", () => {
    expect(expandTitle("")).toBe("");
  });

  it("expands ML", () => {
    const result = expandTitle("ML Engineer");
    expect(result).toContain("machine learning");
  });
});

describe("extractIndustry", () => {
  it("detects fintech", () => {
    const result = extractIndustry("VP at a fintech startup");
    expect(result.some((r) => r.includes("fintech"))).toBe(true);
  });

  it("detects multiple industries", () => {
    const result = extractIndustry("AI-powered healthcare platform");
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("detects venture capital", () => {
    const result = extractIndustry("Partner at venture capital fund");
    expect(result.some((r) => r.includes("venture capital"))).toBe(true);
  });

  it("returns empty for unrecognized industry", () => {
    const result = extractIndustry("baker at local bakery");
    expect(result.length).toBe(0);
  });
});

describe("detectSeniority", () => {
  it("detects executive", () => {
    expect(detectSeniority("CEO")).toBe("executive");
  });

  it("detects founder", () => {
    expect(detectSeniority("Co-Founder & CTO")).toBe("founder");
  });

  it("detects senior leadership", () => {
    expect(detectSeniority("VP Engineering")).toBe("senior leadership");
  });

  it("detects senior IC", () => {
    expect(detectSeniority("Senior Software Engineer")).toBe("senior");
  });

  it("detects mid-level", () => {
    expect(detectSeniority("Product Manager")).toBe("mid-level");
  });

  it("detects early career", () => {
    expect(detectSeniority("Junior Analyst")).toBe("early career");
  });

  it("defaults to IC for unknown", () => {
    expect(detectSeniority("Software Engineer")).toBe("individual contributor");
  });

  it("handles empty", () => {
    expect(detectSeniority("")).toBe("unknown");
  });
});

describe("buildFacetTexts", () => {
  it("builds all facets", () => {
    const result = buildFacetTexts({
      name: "Sarah Chen",
      title: "VP Engineering",
      company: "Stripe",
      headline: "Building payments infrastructure",
    });

    expect(result.role).toContain("VP");
    expect(result.industry).toContain("Stripe");
    expect(result.expertise).toContain("Engineering");
    expect(result.composite).toContain("Sarah Chen");
    expect(result.compact).toContain("Sarah Chen");
  });

  it("handles missing fields gracefully", () => {
    const result = buildFacetTexts({ name: "John" });
    expect(result.composite).toContain("John");
    expect(result.compact).toBe("John");
  });
});

describe("buildEmbeddingText", () => {
  const fields = {
    name: "Alice",
    title: "CTO",
    company: "TechCo",
    headline: "Building the future",
  };

  it("naive strategy joins with dashes", () => {
    const result = buildEmbeddingText(fields, "naive");
    expect(result).toBe("Alice — CTO — TechCo — Building the future");
  });

  it("structured strategy uses labels", () => {
    const result = buildEmbeddingText(fields, "structured");
    expect(result).toContain("role: CTO");
    expect(result).toContain("company: TechCo");
  });

  it("expanded strategy expands title", () => {
    const result = buildEmbeddingText(fields, "expanded");
    expect(result).toContain("chief technology officer");
  });

  it("role_heavy strategy repeats role", () => {
    const result = buildEmbeddingText(fields, "role_heavy");
    expect(result).toContain("professional role: CTO");
  });

  it("composite strategy uses labeled structure", () => {
    const result = buildEmbeddingText(fields, "composite");
    expect(result).toContain("role:");
    expect(result).toContain("company:");
  });
});
