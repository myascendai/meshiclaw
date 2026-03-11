/**
 * Zvec — Text enrichment for higher-quality embeddings.
 *
 * Instead of naively joining fields with " — ", we build structured text
 * compositions that help the embedding model understand different facets
 * of a person's professional identity.
 */

// ---------------------------------------------------------------------------
// Title / Role expansion
// ---------------------------------------------------------------------------

const TITLE_EXPANSIONS: Record<string, string> = {
  ceo: "chief executive officer, CEO, company leader, executive",
  cto: "chief technology officer, CTO, technology leader, engineering executive",
  cfo: "chief financial officer, CFO, finance leader, financial executive",
  coo: "chief operating officer, COO, operations leader",
  cmo: "chief marketing officer, CMO, marketing leader",
  cpo: "chief product officer, CPO, product leader",
  cio: "chief information officer, CIO, information technology leader",
  cso: "chief strategy officer, CSO, strategy leader",
  cro: "chief revenue officer, CRO, revenue leader, sales executive",
  vp: "vice president, VP, senior leader",
  svp: "senior vice president, SVP, executive leader",
  evp: "executive vice president, EVP",
  md: "managing director, MD",
  gm: "general manager, GM",
  pm: "product manager, PM, product management",
  swe: "software engineer, SWE, developer, programmer",
  sde: "software development engineer, SDE, developer",
  ml: "machine learning, ML, artificial intelligence",
  ai: "artificial intelligence, AI, machine learning",
  ux: "user experience, UX, design",
  ui: "user interface, UI, design",
  qa: "quality assurance, QA, testing",
  devops: "DevOps, infrastructure, platform engineering, CI/CD",
  defi: "decentralized finance, DeFi, blockchain finance",
  vc: "venture capital, VC, investment, startup funding",
  pe: "private equity, PE, investment",
  lp: "limited partner, LP, fund investor",
  gp: "general partner, GP, fund manager",
};

/** Expand abbreviated titles into richer text for better embedding. */
export function expandTitle(title: string): string {
  if (!title) return "";
  let expanded = title;
  const lower = title.toLowerCase();

  for (const [abbr, expansion] of Object.entries(TITLE_EXPANSIONS)) {
    // Match whole word or at word boundary (e.g., "CEO" but not inside "ocean")
    const regex = new RegExp(`\\b${abbr}\\b`, "gi");
    if (regex.test(lower)) {
      expanded += ` (${expansion})`;
      break; // Only expand the first match to avoid noise
    }
  }

  return expanded;
}

// ---------------------------------------------------------------------------
// Industry / Sector extraction
// ---------------------------------------------------------------------------

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  "technology / software": [
    "software",
    "saas",
    "tech",
    "platform",
    "cloud",
    "api",
    "developer tools",
    "infrastructure",
    "devtools",
  ],
  "artificial intelligence / machine learning": [
    "ai",
    "ml",
    "machine learning",
    "deep learning",
    "nlp",
    "computer vision",
    "llm",
    "generative ai",
    "neural",
  ],
  "fintech / financial services": [
    "fintech",
    "banking",
    "payments",
    "lending",
    "neobank",
    "insurance",
    "insurtech",
    "financial",
    "finance",
    "trading",
  ],
  "venture capital / investment": [
    "venture",
    "vc",
    "investment",
    "fund",
    "capital",
    "angel",
    "seed",
    "series a",
    "portfolio",
    "investor",
  ],
  "healthcare / biotech": [
    "health",
    "biotech",
    "pharma",
    "medical",
    "clinical",
    "healthtech",
    "telemedicine",
    "genomics",
    "life science",
  ],
  "e-commerce / retail": [
    "ecommerce",
    "e-commerce",
    "retail",
    "marketplace",
    "commerce",
    "dtc",
    "direct to consumer",
    "shop",
  ],
  "crypto / blockchain": [
    "crypto",
    "blockchain",
    "web3",
    "defi",
    "nft",
    "token",
    "dao",
    "decentralized",
  ],
  "education / edtech": [
    "education",
    "edtech",
    "learning",
    "university",
    "school",
    "training",
    "course",
  ],
  "real estate / proptech": ["real estate", "proptech", "property", "housing", "mortgage"],
  "media / entertainment": [
    "media",
    "entertainment",
    "gaming",
    "content",
    "streaming",
    "publishing",
    "music",
    "video",
  ],
  "consulting / professional services": [
    "consulting",
    "advisory",
    "professional services",
    "strategy",
    "management consulting",
  ],
};

/** Extract likely industry/sector from combined person text. */
export function extractIndustry(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(industry);
        break;
      }
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Seniority level detection
// ---------------------------------------------------------------------------

const SENIORITY_PATTERNS: Array<{ pattern: RegExp; level: string }> = [
  { pattern: /\b(founder|co-founder|cofounder)\b/i, level: "founder" },
  { pattern: /\b(c-suite|chief|ceo|cto|cfo|coo|cmo|cpo)\b/i, level: "executive" },
  { pattern: /\b(partner|general partner|managing partner)\b/i, level: "partner" },
  { pattern: /\b(vp|vice president|svp|evp|head of)\b/i, level: "senior leadership" },
  { pattern: /\b(director|senior director)\b/i, level: "director" },
  { pattern: /\b(senior|staff|principal|lead)\b/i, level: "senior" },
  { pattern: /\b(manager|team lead)\b/i, level: "mid-level" },
  { pattern: /\b(associate|analyst|junior|intern)\b/i, level: "early career" },
];

export function detectSeniority(title: string): string {
  if (!title) return "unknown";
  for (const { pattern, level } of SENIORITY_PATTERNS) {
    if (pattern.test(title)) return level;
  }
  return "individual contributor";
}

// ---------------------------------------------------------------------------
// Faceted text composition — the core of the improvement
// ---------------------------------------------------------------------------

export type PersonFields = {
  name: string;
  title?: string;
  company?: string;
  headline?: string;
};

export type FacetTexts = {
  /** Role-focused: title, seniority, function */
  role: string;
  /** Industry-focused: company, sector, market */
  industry: string;
  /** Expertise/skills-focused: extracted from headline + title */
  expertise: string;
  /** Full composite: everything combined with structure */
  composite: string;
  /** Compact: dense info for fast comparison */
  compact: string;
};

/**
 * Build structured text for each facet of a person's identity.
 * Each facet emphasizes different aspects to create complementary embeddings.
 */
export function buildFacetTexts(fields: PersonFields): FacetTexts {
  const { name, title, company, headline } = fields;
  const allText = [name, title, company, headline].filter(Boolean).join(" ");

  // Role facet: who they are professionally
  const expandedTitle = expandTitle(title ?? "");
  const seniority = detectSeniority(title ?? "");
  const roleParts = [
    expandedTitle || "professional",
    seniority !== "unknown" ? `seniority: ${seniority}` : "",
  ].filter(Boolean);
  const role = roleParts.join(". ");

  // Industry facet: what space they're in
  const industries = extractIndustry(allText);
  const industryParts = [
    company ?? "",
    industries.length > 0 ? `industry: ${industries.join(", ")}` : "",
    headline ?? "",
  ].filter(Boolean);
  const industry = industryParts.join(". ");

  // Expertise facet: what they know/do
  const expertiseParts = [
    expandedTitle,
    headline ?? "",
    industries.length > 0 ? industries.join(", ") : "",
  ].filter(Boolean);
  const expertise = expertiseParts.join(". ");

  // Composite: structured combination of everything
  const compositeParts = [
    `${name}`,
    expandedTitle ? `role: ${expandedTitle}` : "",
    company ? `company: ${company}` : "",
    seniority !== "unknown" ? `level: ${seniority}` : "",
    industries.length > 0 ? `industry: ${industries.join(", ")}` : "",
    headline ? `about: ${headline}` : "",
  ].filter(Boolean);
  const composite = compositeParts.join(". ");

  // Compact: dense representation for quick matching
  const compact = [name, title, company].filter(Boolean).join(" | ");

  return { role, industry, expertise, composite, compact };
}

/**
 * Build embedding text using a specific strategy.
 * Used for A/B testing different text compositions.
 */
export type TextStrategy =
  | "naive" // Original: join with " — "
  | "structured" // Labeled fields: "role: X. company: Y."
  | "expanded" // Title expansion + industry extraction
  | "role_heavy" // Emphasize role/title with repetition
  | "industry_heavy" // Emphasize industry/company
  | "composite"; // Full structured composite

export function buildEmbeddingText(fields: PersonFields, strategy: TextStrategy): string {
  const { name, title, company, headline } = fields;

  switch (strategy) {
    case "naive":
      return [name, title, company, headline].filter(Boolean).join(" — ");

    case "structured":
      return [
        name,
        title ? `role: ${title}` : "",
        company ? `company: ${company}` : "",
        headline ? `about: ${headline}` : "",
      ]
        .filter(Boolean)
        .join(". ");

    case "expanded": {
      const expanded = expandTitle(title ?? "");
      const industries = extractIndustry(
        [name, title, company, headline].filter(Boolean).join(" "),
      );
      return [
        name,
        expanded || title,
        company,
        industries.length > 0 ? `sector: ${industries.join(", ")}` : "",
        headline,
      ]
        .filter(Boolean)
        .join(". ");
    }

    case "role_heavy":
      return [
        title ? `${expandTitle(title)}` : "",
        title ? `professional role: ${title}` : "",
        name,
        company ? `at ${company}` : "",
      ]
        .filter(Boolean)
        .join(". ");

    case "industry_heavy": {
      const industries = extractIndustry(
        [name, title, company, headline].filter(Boolean).join(" "),
      );
      return [
        company,
        industries.length > 0 ? `industry: ${industries.join(", ")}` : "",
        company ? `company: ${company}` : "",
        title,
        name,
      ]
        .filter(Boolean)
        .join(". ");
    }

    case "composite":
      return buildFacetTexts(fields).composite;
  }
}
