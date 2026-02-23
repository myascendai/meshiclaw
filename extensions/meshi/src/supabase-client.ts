import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { computeNetworkStrength, strengthTier } from "./scoring.js";

export type MeshiClient = {
  supabase: SupabaseClient;
  personId: string; // people.id
};

export function createMeshiClient(url: string, key: string, personId: string): MeshiClient {
  const supabase = createClient(url, key);
  return { supabase, personId };
}

// ---------------------------------------------------------------------------
// searchContacts — text search among contacts
// ---------------------------------------------------------------------------

export type SearchContactResult = {
  to_person_id: string;
  full_name: string;
  username?: string;
  current_company?: string;
  current_title?: string;
  headline?: string;
  mutual_fit_score?: number;
  similarity_score?: number;
  complementarity_score?: number;
};

export async function searchContacts(
  client: MeshiClient,
  query: string,
  limit = 10,
): Promise<SearchContactResult[]> {
  const { data, error } = await client.supabase.rpc("get_contacts_for_from_person_search_v2", {
    p_from_person_id: client.personId,
    p_query: query,
    p_limit_val: limit,
  });
  if (error) {
    throw new Error(`searchContacts failed: ${error.message}`);
  }
  return (data ?? []) as SearchContactResult[];
}

// ---------------------------------------------------------------------------
// getContacts — list contacts with sort
// ---------------------------------------------------------------------------

export type ContactResult = {
  to_person_id: string;
  full_name: string;
  username?: string;
  current_company?: string;
  current_title?: string;
  headline?: string;
  mutual_fit_score?: number;
  similarity_score?: number;
  complementarity_score?: number;
  icebreaker_data?: unknown;
  relationship_type?: string;
  connection_date?: string;
};

export async function getContacts(
  client: MeshiClient,
  options: { sortBy?: string; sortOrder?: string; limit?: number } = {},
): Promise<ContactResult[]> {
  const { sortBy = "mutual_fit_score", sortOrder = "desc", limit = 20 } = options;
  const { data, error } = await client.supabase.rpc("get_contacts_for_from_person", {
    p_from_person_id: client.personId,
    p_sort_by: sortBy,
    p_sort_order: sortOrder,
    p_limit_val: limit,
  });
  if (error) {
    throw new Error(`getContacts failed: ${error.message}`);
  }
  return (data ?? []) as ContactResult[];
}

// ---------------------------------------------------------------------------
// getMutualFits — top fits with icebreakers
// ---------------------------------------------------------------------------

export type MutualFitResult = ContactResult;

export async function getMutualFits(
  client: MeshiClient,
  options: { minScore?: number; limit?: number } = {},
): Promise<MutualFitResult[]> {
  const { minScore = 0, limit = 20 } = options;
  const { data, error } = await client.supabase.rpc("get_contacts_for_from_person", {
    p_from_person_id: client.personId,
    p_sort_by: "mutual_fit_score",
    p_sort_order: "desc",
    p_limit_val: limit,
  });
  if (error) {
    throw new Error(`getMutualFits failed: ${error.message}`);
  }
  const rows = (data ?? []) as MutualFitResult[];
  return rows.filter((r) => (r.mutual_fit_score ?? 0) > minScore);
}

// ---------------------------------------------------------------------------
// getPersonDetails — full person profile + relationship data
// ---------------------------------------------------------------------------

export type PersonDetails = {
  id: string;
  full_name: string;
  username?: string;
  current_company?: string;
  current_title?: string;
  headline?: string;
  location?: string;
  linkedin_id?: string;
  detailed_summary?: string;
  overall_assessment?: string;
  primary_email?: string;
  mutual_fit?: {
    mutual_fit_score?: number;
    similarity_score?: number;
    complementarity_score?: number;
    icebreaker_data?: unknown;
    icebreaker_mini_data?: unknown;
    note_about_from_person?: string;
  } | null;
  social_connection?: {
    notes?: string;
    made_relevant_at?: string;
    relationship_type?: string;
  } | null;
};

export async function getPersonDetails(
  client: MeshiClient,
  personId: string,
): Promise<PersonDetails | null> {
  const { data: person, error: personError } = await client.supabase
    .from("people")
    .select(
      "id, full_name, username, current_company, current_title, headline, location, linkedin_id, detailed_summary, overall_assessment, primary_email",
    )
    .eq("id", personId)
    .single();

  if (personError || !person) {
    if (personError?.code === "PGRST116") {
      return null;
    }
    throw new Error(`getPersonDetails failed: ${personError?.message ?? "not found"}`);
  }

  // Mutual fit between the current user and this person (check both directions)
  const { data: mfRows } = await client.supabase
    .from("mutual_fits")
    .select(
      "mutual_fit_score, similarity_score, complementarity_score, icebreaker_data, icebreaker_mini_data, note_about_from_person",
    )
    .or(
      `and(from_person_id.eq.${personId},to_person_id.eq.${client.personId}),and(from_person_id.eq.${client.personId},to_person_id.eq.${personId})`,
    )
    .limit(2);

  // Social connection notes from the current user about this person
  const { data: sc } = await client.supabase
    .from("social_connections")
    .select("notes, made_relevant_at, relationship_type")
    .eq("from_person_id", client.personId)
    .eq("to_person_id", personId)
    .limit(1)
    .single();

  return {
    ...person,
    mutual_fit: mfRows?.[0] ?? null,
    social_connection: sc ?? null,
  };
}

// ---------------------------------------------------------------------------
// getStrongestConnections — pre-formatted natural language results
// ---------------------------------------------------------------------------

export type NaturalConnectionResult = {
  name: string;
  role: string;
  strength: string;
  context: string;
  icebreaker?: string;
};

export async function getStrongestConnections(
  client: MeshiClient,
  limit = 10,
): Promise<NaturalConnectionResult[]> {
  const contacts = await getContacts(client, {
    sortBy: "mutual_fit_score",
    sortOrder: "desc",
    limit: limit * 2, // Fetch extra to compensate for scoring re-rank
  });

  const scored = contacts.map((c) => {
    const connectionDate = c.connection_date ? new Date(c.connection_date) : null;
    const daysSince = connectionDate
      ? Math.floor((Date.now() - connectionDate.getTime()) / (1000 * 60 * 60 * 24))
      : 365;

    const networkScore = computeNetworkStrength({
      mutualFitScore: c.mutual_fit_score ?? 0,
      mutualConnectionsCount: 0, // Would need separate query
      interactionRecency: daysSince,
      professionalOverlap: 0, // Would need features data
    });

    const tier = strengthTier(networkScore);
    const title = c.current_title ?? "";
    const company = c.current_company ?? "";
    const role =
      title && company ? `${title} at ${company}` : title || company || "Professional contact";

    let context = c.relationship_type ?? "connection";
    if (c.mutual_fit_score != null) {
      context += ` (${Math.round(c.mutual_fit_score * 100)}% compatibility)`;
    }

    let icebreaker: string | undefined;
    if (c.icebreaker_data && typeof c.icebreaker_data === "object") {
      const ib = c.icebreaker_data as Record<string, unknown>;
      const text = ib.icebreaker ?? ib.text ?? ib.suggestion;
      if (typeof text === "string") icebreaker = text;
    }

    return {
      name: c.full_name,
      role,
      strength: tier,
      context,
      icebreaker,
      _score: networkScore,
    };
  });

  // Sort by composite score and return top N
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit).map(({ _score, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// listContactsDirect — fallback contact list for sync/indexing
// ---------------------------------------------------------------------------

/**
 * Fetch contacts by reading social_connections + people directly.
 * This is a fallback for environments where the RPC helpers are missing/out of sync.
 */
export async function listContactsDirect(
  client: MeshiClient,
  limit = 2000,
): Promise<ContactResult[]> {
  // 1) Get to_person_ids from social_connections
  const { data: scRows, error: scErr } = await client.supabase
    .from("social_connections")
    .select("to_person_id, relationship_type, connection_date")
    .eq("from_person_id", client.personId)
    .limit(limit);

  if (scErr) {
    throw new Error(`listContactsDirect failed (social_connections): ${scErr.message}`);
  }

  const ids = (scRows ?? [])
    .map((r: any) => r.to_person_id as string)
    .filter((id) => typeof id === "string" && id.length > 0);

  if (ids.length === 0) return [];

  // 2) Fetch people records
  const { data: peopleRows, error: peopleErr } = await client.supabase
    .from("people")
    .select("id, full_name, username, current_company, current_title, headline")
    .in("id", ids);

  if (peopleErr) {
    throw new Error(`listContactsDirect failed (people): ${peopleErr.message}`);
  }

  const byId = new Map<string, any>();
  for (const p of peopleRows ?? []) byId.set((p as any).id as string, p);

  // 3) Merge
  const merged: ContactResult[] = [];
  for (const sc of scRows ?? []) {
    const id = (sc as any).to_person_id as string;
    const p = byId.get(id);
    if (!p) continue;
    merged.push({
      to_person_id: id,
      full_name: (p as any).full_name,
      username: (p as any).username ?? undefined,
      current_company: (p as any).current_company ?? undefined,
      current_title: (p as any).current_title ?? undefined,
      headline: (p as any).headline ?? undefined,
      relationship_type: (sc as any).relationship_type ?? undefined,
      connection_date: (sc as any).connection_date ?? undefined,
    });
  }

  return merged;
}
