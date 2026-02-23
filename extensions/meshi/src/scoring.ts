/** Network strength scoring for relationship intelligence. */

export type NetworkStrengthInput = {
  /** Mutual fit score from mutual_fits table (0-1). */
  mutualFitScore?: number;
  /** Number of shared/mutual connections. */
  mutualConnectionsCount?: number;
  /** Days since last interaction or connection. */
  interactionRecency?: number;
  /** Professional overlap computed from features (0-1). */
  professionalOverlap?: number;
};

// Weights: mutualFitScore is de-emphasized (algorithm still evolving),
// recency and connections carry more signal for now.
const WEIGHTS = {
  mutualFitScore: 0.15,
  mutualConnections: 0.3,
  interactionRecency: 0.35,
  professionalOverlap: 0.2,
};

/**
 * Compute a composite network strength score (0-1) from multiple factors.
 */
export function computeNetworkStrength(input: NetworkStrengthInput): number {
  const fitComponent = (input.mutualFitScore ?? 0) * WEIGHTS.mutualFitScore;

  // Normalize mutual connections: cap at 20 shared connections
  const connectionsCapped = Math.min(input.mutualConnectionsCount ?? 0, 20);
  const connectionsComponent = (connectionsCapped / 20) * WEIGHTS.mutualConnections;

  // Recency: exponential decay — recent interactions score higher
  // 0 days = 1.0, 30 days = ~0.5, 90 days = ~0.15, 365 days = ~0.001
  const daysSince = input.interactionRecency ?? 365;
  const recencyComponent = Math.exp(-daysSince / 45) * WEIGHTS.interactionRecency;

  const overlapComponent = (input.professionalOverlap ?? 0) * WEIGHTS.professionalOverlap;

  return fitComponent + connectionsComponent + recencyComponent + overlapComponent;
}

/**
 * Classify a network strength score into a human-readable tier.
 */
export function strengthTier(score: number): "strong" | "moderate" | "growing" | "new" {
  if (score >= 0.7) return "strong";
  if (score >= 0.45) return "moderate";
  if (score >= 0.2) return "growing";
  return "new";
}
