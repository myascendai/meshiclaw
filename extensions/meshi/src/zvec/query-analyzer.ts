/**
 * Zvec — Query analysis for intent-adaptive search.
 *
 * Detects what the user is looking for (role, industry, skill, company, etc.)
 * and adjusts facet weights dynamically. Also expands queries for better recall.
 */

// ---------------------------------------------------------------------------
// Query intent classification
// ---------------------------------------------------------------------------

export type QueryIntent =
  | "role" // Looking for people by job function
  | "industry" // Looking for people in a sector
  | "company" // Looking for people at a specific company
  | "skill" // Looking for people with specific skills
  | "location" // Looking for people in a geography
  | "seniority" // Looking for people at a specific level
  | "general"; // Broad/mixed query

export type QueryAnalysis = {
  /** Primary detected intent */
  intent: QueryIntent;
  /** Confidence 0-1 */
  confidence: number;
  /** Adaptive facet weights based on intent */
  weights: FacetWeights;
  /** Expanded query text for better recall */
  expandedQuery: string;
};

export type FacetWeights = {
  role: number;
  industry: number;
  expertise: number;
  composite: number;
};

// Intent detection patterns
const ROLE_PATTERNS = [
  /\b(engineer|developer|programmer|architect|designer|manager|director|vp|ceo|cto|cfo|founder|partner|analyst|consultant|scientist|researcher|lead|head of|investor)\b/i,
  /\b(product manager|project manager|data scientist|software engineer|machine learning)\b/i,
];

const INDUSTRY_PATTERNS = [
  /\b(fintech|healthtech|edtech|proptech|biotech|insurtech|agritech|legaltech|regtech)\b/i,
  /\b(healthcare|finance|education|real estate|crypto|blockchain|saas|e-?commerce|gaming|media)\b/i,
  /\b(venture capital|private equity|investment banking|asset management)\b/i,
];

const COMPANY_PATTERNS = [
  /\bat\s+\w+/i,
  /\b(google|meta|apple|amazon|microsoft|stripe|openai|anthropic|tesla)\b/i,
  /\b(y combinator|sequoia|a16z|andreessen|benchmark|accel)\b/i,
];

const SKILL_PATTERNS = [
  /\b(python|javascript|typescript|rust|go|java|react|node|kubernetes|docker|aws|gcp|azure)\b/i,
  /\b(machine learning|deep learning|nlp|computer vision|data science|llm|generative ai)\b/i,
  /\b(growth|marketing|sales|fundraising|strategy|operations|analytics)\b/i,
];

const LOCATION_PATTERNS = [
  /\b(mexico|latam|latin america|brazil|colombia|chile|argentina|peru)\b/i,
  /\b(silicon valley|san francisco|new york|london|berlin|tokyo|singapore)\b/i,
  /\b(us|usa|europe|asia|africa|middle east)\b/i,
];

const SENIORITY_PATTERNS = [
  /\b(senior|junior|mid-level|entry|executive|c-suite|leadership|staff|principal)\b/i,
  /\b(early stage|experienced|seasoned|emerging)\b/i,
];

function matchScore(text: string, patterns: RegExp[]): number {
  let matches = 0;
  for (const p of patterns) {
    if (p.test(text)) matches++;
  }
  return matches / patterns.length;
}

/** Analyze a search query to detect intent and generate adaptive weights. */
export function analyzeQuery(query: string): QueryAnalysis {
  const scores: Record<QueryIntent, number> = {
    role: matchScore(query, ROLE_PATTERNS),
    industry: matchScore(query, INDUSTRY_PATTERNS),
    company: matchScore(query, COMPANY_PATTERNS),
    skill: matchScore(query, SKILL_PATTERNS),
    location: matchScore(query, LOCATION_PATTERNS),
    seniority: matchScore(query, SENIORITY_PATTERNS),
    general: 0.1, // baseline
  };

  // Find dominant intent
  let maxIntent: QueryIntent = "general";
  let maxScore = 0;
  for (const [intent, score] of Object.entries(scores) as Array<[QueryIntent, number]>) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent;
    }
  }

  const confidence = Math.min(maxScore * 2, 1); // Scale up for single-pattern matches

  // Generate adaptive weights based on intent
  const weights = getAdaptiveWeights(maxIntent, confidence);

  // Expand query
  const expandedQuery = expandQuery(query, maxIntent);

  return { intent: maxIntent, confidence, weights, expandedQuery };
}

// ---------------------------------------------------------------------------
// Adaptive weight profiles
// ---------------------------------------------------------------------------

const WEIGHT_PROFILES: Record<QueryIntent, FacetWeights> = {
  role: { role: 0.5, industry: 0.1, expertise: 0.25, composite: 0.15 },
  industry: { role: 0.1, industry: 0.5, expertise: 0.15, composite: 0.25 },
  company: { role: 0.1, industry: 0.45, expertise: 0.1, composite: 0.35 },
  skill: { role: 0.15, industry: 0.1, expertise: 0.5, composite: 0.25 },
  location: { role: 0.15, industry: 0.2, expertise: 0.15, composite: 0.5 },
  seniority: { role: 0.45, industry: 0.1, expertise: 0.2, composite: 0.25 },
  general: { role: 0.25, industry: 0.25, expertise: 0.25, composite: 0.25 },
};

function getAdaptiveWeights(intent: QueryIntent, confidence: number): FacetWeights {
  const profile = WEIGHT_PROFILES[intent];
  const uniform = WEIGHT_PROFILES.general;

  // Blend between uniform and profile based on confidence
  return {
    role: uniform.role + (profile.role - uniform.role) * confidence,
    industry: uniform.industry + (profile.industry - uniform.industry) * confidence,
    expertise: uniform.expertise + (profile.expertise - uniform.expertise) * confidence,
    composite: uniform.composite + (profile.composite - uniform.composite) * confidence,
  };
}

// ---------------------------------------------------------------------------
// Query expansion
// ---------------------------------------------------------------------------

const QUERY_EXPANSIONS: Record<string, string> = {
  vc: "venture capital investor fund partner startup funding",
  ai: "artificial intelligence machine learning deep learning",
  ml: "machine learning artificial intelligence data science",
  saas: "software as a service cloud platform subscription",
  fintech: "financial technology banking payments digital finance",
  defi: "decentralized finance blockchain crypto DeFi",
  web3: "web3 blockchain decentralized crypto",
  pm: "product manager product management",
  swe: "software engineer developer programming",
  devops: "DevOps infrastructure platform engineering cloud",
  latam: "Latin America Mexico Brazil Colombia Chile Argentina",
  "pre-seed": "pre-seed early stage angel investor startup",
  "series a": "series A venture capital growth stage startup funding",
};

function expandQuery(query: string, _intent: QueryIntent): string {
  const lower = query.toLowerCase();
  const parts = [query];

  for (const [trigger, expansion] of Object.entries(QUERY_EXPANSIONS)) {
    if (lower.includes(trigger)) {
      parts.push(expansion);
    }
  }

  return parts.join(". ");
}

// ---------------------------------------------------------------------------
// Preset weight configurations for A/B testing
// ---------------------------------------------------------------------------

export type WeightPreset =
  | "uniform"
  | "role_focused"
  | "industry_focused"
  | "expertise_focused"
  | "adaptive";

export const WEIGHT_PRESETS: Record<string, FacetWeights> = {
  uniform: { role: 0.25, industry: 0.25, expertise: 0.25, composite: 0.25 },
  role_focused: { role: 0.45, industry: 0.15, expertise: 0.25, composite: 0.15 },
  industry_focused: { role: 0.15, industry: 0.45, expertise: 0.15, composite: 0.25 },
  expertise_focused: { role: 0.2, industry: 0.15, expertise: 0.45, composite: 0.2 },
  composite_heavy: { role: 0.15, industry: 0.15, expertise: 0.15, composite: 0.55 },
  balanced_no_comp: { role: 0.35, industry: 0.35, expertise: 0.3, composite: 0.0 },
};
