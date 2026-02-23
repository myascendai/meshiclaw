/** Connection graph building and introduction path finding. */

import type { MeshiClient } from "./supabase-client.js";

export type ConnectionGraph = {
  /** Adjacency list: nodeId -> Map<neighborId, edgeWeight> (weight = 1 - strength) */
  adjacency: Map<string, Map<string, number>>;
  /** Person metadata for display */
  names: Map<string, string>;
};

export type IntroductionPath = {
  steps: Array<{ id: string; name: string }>;
  description: string;
};

/**
 * Build a connection graph from social_connections data.
 * Edge weight = 1 - normalized mutual_fit_score (lower weight = stronger connection for Dijkstra).
 */
export async function buildConnectionGraph(client: MeshiClient): Promise<ConnectionGraph> {
  const adjacency = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();

  // Fetch all social connections for the user's network (2 hops)
  const { data: connections, error } = await client.supabase
    .from("social_connections")
    .select("from_person_id, to_person_id")
    .or(`from_person_id.eq.${client.personId},to_person_id.eq.${client.personId}`)
    .limit(1000);

  if (error || !connections) return { adjacency, names };

  // Collect all person IDs to fetch names in bulk
  const allPersonIds = new Set<string>();
  for (const conn of connections) {
    allPersonIds.add(conn.from_person_id as string);
    allPersonIds.add(conn.to_person_id as string);
  }

  // Also fetch 2nd-hop connections to enable paths through intermediaries
  const neighborIds = new Set<string>();
  for (const conn of connections) {
    const from = conn.from_person_id as string;
    const to = conn.to_person_id as string;
    if (from !== client.personId) neighborIds.add(from);
    if (to !== client.personId) neighborIds.add(to);
  }

  type ConnectionRow = { from_person_id: unknown; to_person_id: unknown };
  let secondHopConnections: ConnectionRow[] = [];
  if (neighborIds.size > 0) {
    const ids = Array.from(neighborIds).slice(0, 100); // Cap for performance
    const { data: hop2 } = await client.supabase
      .from("social_connections")
      .select("from_person_id, to_person_id")
      .in("from_person_id", ids)
      .limit(2000);
    if (hop2) {
      secondHopConnections = hop2;
      for (const conn of hop2) {
        allPersonIds.add(conn.from_person_id as string);
        allPersonIds.add(conn.to_person_id as string);
      }
    }
  }

  // Bulk fetch names for all people
  const personIdList = Array.from(allPersonIds).slice(0, 500);
  const { data: people } = await client.supabase
    .from("people")
    .select("id, full_name")
    .in("id", personIdList);
  if (people) {
    for (const p of people) {
      if (p.full_name) names.set(p.id as string, p.full_name as string);
    }
  }

  const allConnections = [...connections, ...secondHopConnections];

  for (const conn of allConnections) {
    const from = conn.from_person_id as string;
    const to = conn.to_person_id as string;

    // Default edge weight 0.5 (moderate strength)
    const weight = 0.5;

    if (!adjacency.has(from)) adjacency.set(from, new Map());
    if (!adjacency.has(to)) adjacency.set(to, new Map());
    adjacency.get(from)!.set(to, weight);
    adjacency.get(to)!.set(from, weight);
  }

  // Enhance edge weights with mutual fit scores where available
  const { data: fits } = await client.supabase
    .from("mutual_fits")
    .select("from_person_id, to_person_id, mutual_fit_score")
    .eq("from_person_id", client.personId)
    .limit(500);

  if (fits) {
    for (const fit of fits) {
      const to = fit.to_person_id as string;
      const score = (fit.mutual_fit_score as number) ?? 0.5;
      const weight = 1 - score; // Lower weight = stronger connection
      if (adjacency.has(client.personId)) {
        adjacency.get(client.personId)!.set(to, weight);
      }
      if (adjacency.has(to)) {
        adjacency.get(to)!.set(client.personId, weight);
      }
    }
  }

  return { adjacency, names };
}

/**
 * Find the shortest introduction path using modified Dijkstra.
 * Edge weight = 1 - strength, so strongest paths have lowest total weight.
 */
export function findIntroductionPath(
  graph: ConnectionGraph,
  sourceId: string,
  targetId: string,
  maxHops = 4,
): IntroductionPath | null {
  if (sourceId === targetId) return null;

  const { adjacency, names } = graph;
  if (!adjacency.has(sourceId)) return null;

  // Dijkstra with hop limit
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const hops = new Map<string, number>();
  const visited = new Set<string>();

  dist.set(sourceId, 0);
  hops.set(sourceId, 0);

  // Simple priority queue using sorted array (adequate for our graph size)
  const queue: Array<{ id: string; dist: number }> = [{ id: sourceId, dist: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.dist - b.dist);
    const current = queue.shift()!;

    if (visited.has(current.id)) continue;
    visited.add(current.id);

    if (current.id === targetId) break;

    const currentHops = hops.get(current.id) ?? 0;
    if (currentHops >= maxHops) continue;

    const neighbors = adjacency.get(current.id);
    if (!neighbors) continue;

    for (const [neighborId, weight] of neighbors) {
      if (visited.has(neighborId)) continue;
      const newDist = current.dist + weight;
      if (!dist.has(neighborId) || newDist < dist.get(neighborId)!) {
        dist.set(neighborId, newDist);
        prev.set(neighborId, current.id);
        hops.set(neighborId, currentHops + 1);
        queue.push({ id: neighborId, dist: newDist });
      }
    }
  }

  if (!prev.has(targetId)) return null;

  // Reconstruct path
  const path: string[] = [];
  let current: string | undefined = targetId;
  while (current !== undefined) {
    path.unshift(current);
    current = prev.get(current);
  }

  const steps = path.map((id) => ({
    id,
    name: names.get(id) ?? "Unknown",
  }));

  // Build human-readable description
  const middleNames = steps.slice(1, -1).map((s) => s.name);
  const targetName = steps[steps.length - 1].name;
  let description: string;
  if (middleNames.length === 0) {
    description = `You're directly connected to ${targetName}.`;
  } else {
    description = `Through ${middleNames.join(" -> ")} -> ${targetName}`;
  }

  return { steps, description };
}
