import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { getAuthEntry } from "./auth-store.js";
import { buildConnectionGraph, findIntroductionPath } from "./graph.js";
import { extractTelegramUserId } from "./session-utils.js";
import {
  createMeshiClient,
  searchContacts,
  getContacts,
  getMutualFits,
  getPersonDetails,
  listContactsDirect,
  type MeshiClient,
} from "./supabase-client.js";
import { getStrongestConnections } from "./supabase-client.js";
import { VectorStore, createEmbeddingProvider, type EmbeddingProvider } from "./zvec/index.js";

// Shared Zvec store + embedding provider (lazy-initialized per sync)
let zvecStore: VectorStore | null = null;
let embeddingProvider: EmbeddingProvider | null = null;

export function getZvecStore(): VectorStore | null {
  return zvecStore;
}

export function initZvecStore(): VectorStore {
  if (!zvecStore) {
    zvecStore = new VectorStore({ name: "meshi-people", dimensions: 1024 });
  }
  return zvecStore;
}

export function getOrCreateEmbeddingProvider(): EmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider = createEmbeddingProvider();
  }
  return embeddingProvider;
}

type SupabaseConfig = { url: string; key: string };

const AUTH_ERROR = jsonResult({
  error: "Not authenticated. Use /login <email> first.",
});

/** Resolve Supabase URL + key from plugin config / env. Returns null if missing. */
function resolveSupabaseConfig(ctx: OpenClawPluginToolContext): SupabaseConfig | null {
  const pluginConfig = (ctx.config as Record<string, unknown>)?.plugins as
    | Record<string, unknown>
    | undefined;
  const entries = pluginConfig?.entries as Record<string, unknown> | undefined;
  const meshiConfig = entries?.meshi as Record<string, unknown> | undefined;
  const config = meshiConfig?.config as Record<string, unknown> | undefined;

  const url = (config?.supabaseUrl as string) ?? process.env.MESHI_SUPABASE_URL;
  const key = (config?.supabaseKey as string) ?? process.env.MESHI_SUPABASE_KEY;

  if (!url || !key) return null;
  return { url, key };
}

/**
 * Resolve a MeshiClient at execution time (not factory time).
 * Checks the auth store on every call so login mid-session works.
 */
function resolveMeshiClient(
  ctx: OpenClawPluginToolContext,
  sb: SupabaseConfig,
): MeshiClient | null {
  // Try to resolve user from Telegram auth store
  const telegramUserId = extractTelegramUserId(ctx.sessionKey);
  if (telegramUserId) {
    const authEntry = getAuthEntry(telegramUserId);
    if (authEntry) {
      return createMeshiClient(sb.url, sb.key, authEntry.personId);
    }
    return null;
  }

  // Fallback: static config for non-Telegram contexts
  const pluginConfig = (ctx.config as Record<string, unknown>)?.plugins as
    | Record<string, unknown>
    | undefined;
  const entries = pluginConfig?.entries as Record<string, unknown> | undefined;
  const meshiConfig = entries?.meshi as Record<string, unknown> | undefined;
  const config = meshiConfig?.config as Record<string, unknown> | undefined;
  const personId = (config?.meshiUserId as string) ?? process.env.MESHI_USER_ID;
  if (!personId) return null;
  return createMeshiClient(sb.url, sb.key, personId);
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const SearchContactsSchema = Type.Object({
  query: Type.String({ description: "Search text — name, company, keyword" }),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
});

const GetContactsSchema = Type.Object({
  sort_by: Type.Optional(
    Type.String({
      description:
        "Sort field: mutual_fit_score, full_name, current_company (default: mutual_fit_score)",
    }),
  ),
  sort_order: Type.Optional(
    Type.String({ description: "Sort order: asc or desc (default: desc)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
});

const GetMutualFitsSchema = Type.Object({
  min_score: Type.Optional(
    Type.Number({ description: "Minimum mutual fit score threshold (0-1, default 0)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
});

const GetPersonDetailsSchema = Type.Object({
  person_id: Type.String({ description: "UUID of the person to look up" }),
});

const StrongestConnectionsSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
});

const FindIntroductionPathSchema = Type.Object({
  target_name: Type.String({ description: "Name of the person you want an introduction to" }),
  max_hops: Type.Optional(Type.Number({ description: "Maximum intermediaries (default 4)" })),
});

const SyncSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max contacts to index (default 2000)" })),
  reset: Type.Optional(
    Type.Boolean({ description: "Clear existing local index first (default false)" }),
  ),
});

const SyncFromSearchSchema = Type.Object({
  query: Type.String({
    description: "Search query to pull people from Meshi DB and index locally",
  }),
  limit: Type.Optional(Type.Number({ description: "Max results to index (default 200)" })),
  reset: Type.Optional(
    Type.Boolean({ description: "Clear existing local index first (default false)" }),
  ),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMeshiTools(): Array<(ctx: OpenClawPluginToolContext) => AnyAgentTool | null> {
  return [
    createSyncTool,
    createSyncFromSearchTool,
    createSearchContactsTool,
    createGetContactsTool,
    createGetMutualFitsTool,
    createGetPersonDetailsTool,
    createStrongestConnectionsTool,
    createFindIntroductionPathTool,
  ];
}

function createSyncTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Sync",
    name: "meshi_sync",
    description:
      "Build/refresh the local semantic index used by meshi_search_contacts + meshi_smart_search. Uses Mistral embeddings when MISTRAL_API_KEY is set; otherwise falls back to a deterministic hash embedding.",
    parameters: SyncSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;

      const limit = readNumberParam(params, "limit", { integer: true }) ?? 2000;
      const reset = params?.reset === true;

      const store = initZvecStore();
      // Load existing index from disk if present
      try {
        await store.load();
      } catch {
        // ignore
      }

      if (reset) store.clear();

      // Prefer RPC contact list, but fall back to direct table read for robustness.
      let contacts = [];
      try {
        contacts = await getContacts(client, {
          sortBy: "mutual_fit_score",
          sortOrder: "desc",
          limit,
        });
      } catch {
        contacts = await listContactsDirect(client, limit);
      }

      const provider = getOrCreateEmbeddingProvider();
      let indexed = 0;

      for (const c of contacts) {
        const id = c.to_person_id;
        if (!id) continue;
        const text = [c.full_name, c.current_title, c.current_company, c.headline]
          .filter(Boolean)
          .join(" — ");
        try {
          const vec = await provider.embed(text);
          store.upsert(id, vec, {
            name: c.full_name,
            title: c.current_title,
            company: c.current_company,
            headline: c.headline,
            relationship_type: c.relationship_type,
            mutual_fit_score: c.mutual_fit_score,
          });
          indexed++;
        } catch {
          // skip individual failures
        }
      }

      await store.save();
      return jsonResult({
        ok: true,
        indexed,
        totalFetched: contacts.length,
        storeSize: store.size,
      });
    },
  };
}

function createSyncFromSearchTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Sync From Search",
    name: "meshi_sync_from_search",
    description:
      "Index people returned by a Meshi DB search into the local semantic index. Useful when your contact graph is empty but you still want meshi_smart_search over a curated slice (e.g., 'VC', 'MCP', 'AI engineer').",
    parameters: SyncFromSearchSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;

      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 200;
      const reset = params?.reset === true;

      const store = initZvecStore();
      try {
        await store.load();
      } catch {}
      if (reset) store.clear();

      let rows = [];
      try {
        rows = await searchContacts(client, query, limit);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ ok: false, indexed: 0, totalFetched: 0, error: message });
      }

      const provider = getOrCreateEmbeddingProvider();
      let indexed = 0;
      for (const r of rows) {
        const id = r.to_person_id;
        if (!id) continue;
        const text = [r.full_name, r.current_title, r.current_company, r.headline]
          .filter(Boolean)
          .join(" — ");
        try {
          const vec = await provider.embed(text);
          store.upsert(id, vec, {
            name: r.full_name,
            title: r.current_title,
            company: r.current_company,
            headline: r.headline,
            mutual_fit_score: r.mutual_fit_score,
            similarity_score: r.similarity_score,
            complementarity_score: r.complementarity_score,
          });
          indexed++;
        } catch {}
      }

      await store.save();
      return jsonResult({
        ok: true,
        query,
        indexed,
        totalFetched: rows.length,
        storeSize: store.size,
      });
    },
  };
}

function createSearchContactsTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Search Contacts",
    name: "meshi_search_contacts",
    description:
      "Search the user's contacts by name, company, keyword, or natural language description. Uses local index when available for semantic matching, falls back to database search.",
    parameters: SearchContactsSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;

      // Try local zvec index first (semantic search)
      const store = getZvecStore();
      if (store && store.size > 0) {
        try {
          const provider = getOrCreateEmbeddingProvider();
          const queryVector = await provider.embed(query);
          const zvecResults = store.search(queryVector, limit);
          const results = zvecResults.map((r) => ({
            full_name: r.metadata.name as string,
            current_title: r.metadata.title as string | undefined,
            current_company: r.metadata.company as string | undefined,
            headline: r.metadata.headline as string | undefined,
            to_person_id: r.id,
            relevance_score: Math.round(r.score * 100) / 100,
            network_strength: r.metadata.network_strength as string | undefined,
            ...(r.metadata.icebreaker_data != null
              ? { icebreaker_data: r.metadata.icebreaker_data }
              : {}),
          }));
          return jsonResult({ results, count: results.length, source: "local_index" });
        } catch {
          // Zvec failed — fall through to DB
        }
      }

      // Fallback: database search
      try {
        const results = await searchContacts(client, query, limit);
        return jsonResult({ results, count: results.length, source: "database" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

function createGetContactsTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Get Contacts",
    name: "meshi_get_contacts",
    description:
      "List the user's contacts sorted by fit score, name, or company. Returns contacts with relationship data and icebreakers.",
    parameters: GetContactsSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const sortBy = readStringParam(params, "sort_by");
      const sortOrder = readStringParam(params, "sort_order");
      const limit = readNumberParam(params, "limit", { integer: true });
      try {
        const results = await getContacts(client, {
          sortBy: sortBy ?? undefined,
          sortOrder: sortOrder ?? undefined,
          limit: limit ?? 20,
        });
        return jsonResult({ results, count: results.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

function createGetMutualFitsTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Get Mutual Fits",
    name: "meshi_get_mutual_fits",
    description:
      "Get top compatibility matches with icebreaker suggestions. Sorted by mutual fit score descending.",
    parameters: GetMutualFitsSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const minScore = readNumberParam(params, "min_score");
      const limit = readNumberParam(params, "limit", { integer: true });
      try {
        const results = await getMutualFits(client, {
          minScore: minScore ?? undefined,
          limit: limit ?? 20,
        });
        return jsonResult({ results, count: results.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

function createGetPersonDetailsTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Get Person Details",
    name: "meshi_get_person_details",
    description:
      "Get the full profile for a specific person including mutual fit data, icebreakers, and relationship notes.",
    parameters: GetPersonDetailsSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const personId = readStringParam(params, "person_id", { required: true });
      try {
        const result = await getPersonDetails(client, personId);
        if (!result) {
          return jsonResult({ error: "Person not found", person_id: personId });
        }
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message, person_id: personId });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Strongest Connections
// ---------------------------------------------------------------------------

function createStrongestConnectionsTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Strongest Connections",
    name: "meshi_strongest_connections",
    description:
      "Get your strongest professional connections ranked by network strength score. Returns names, roles, relationship strength, and conversation starters.",
    parameters: StrongestConnectionsSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
      try {
        const results = await getStrongestConnections(client, limit);
        return jsonResult({ results, count: results.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Introduction Paths
// ---------------------------------------------------------------------------

function createFindIntroductionPathTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const sb = resolveSupabaseConfig(ctx);
  if (!sb) return null;
  return {
    label: "Meshi Find Introduction Path",
    name: "meshi_find_introduction_path",
    description:
      "Find the shortest introduction path to reach a person through your network. Returns a chain of people who can introduce you.",
    parameters: FindIntroductionPathSchema,
    execute: async (_toolCallId, params) => {
      const client = resolveMeshiClient(ctx, sb);
      if (!client) return AUTH_ERROR;
      const targetName = readStringParam(params, "target_name", { required: true });
      const maxHops = readNumberParam(params, "max_hops", { integer: true }) ?? 4;
      try {
        // First search for the target person
        const searchResults = await searchContacts(client, targetName, 1);
        if (searchResults.length === 0) {
          return jsonResult({ error: "Could not find that person in your network.", path: null });
        }
        const target = searchResults[0];
        const targetId = target.to_person_id;

        // Build graph and find path
        const graph = await buildConnectionGraph(client);
        const path = findIntroductionPath(graph, client.personId, targetId, maxHops);

        if (!path) {
          return jsonResult({
            target: {
              name: target.full_name,
              company: target.current_company,
              title: target.current_title,
            },
            error: "No introduction path found within reach.",
            path: null,
          });
        }

        return jsonResult({
          target: {
            name: target.full_name,
            company: target.current_company,
            title: target.current_title,
          },
          path: path.steps,
          description: path.description,
          total_hops: path.steps.length - 1,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message, path: null });
      }
    },
  };
}
