---
name: meshi-network
description: Meshi network intelligence - query contacts, relationships, and mutual fits
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "always": true,
        "requires": { "env": ["MESHI_SUPABASE_URL", "MESHI_SUPABASE_KEY"] },
        "primaryEnv": "MESHI_SUPABASE_URL",
      },
  }
---

# Meshi Network Intelligence

You have access to the user's professional network via Meshi tools.

## Available Tools

- `meshi_search_contacts` - Find people by name, company, title, description, or natural language. Uses local index for semantic matching when available, falls back to database.
- `meshi_get_contacts` - List user's contacts with relationship scores
- `meshi_get_mutual_fits` - Get compatibility scores between people with icebreaker suggestions
- `meshi_get_person_details` - Deep dive into one person's profile and connections
- `meshi_strongest_connections` - Get your strongest connections ranked by network strength
- `meshi_find_introduction_path` - Find the shortest path to reach someone through mutual connections
- `meshi_sync` - Build/refresh the local semantic index (zvec) used for semantic search.
- `meshi_sync_from_search` - Index people returned by a Meshi DB search into the local semantic index (useful when your contact graph sync is empty, but you still want smart search over a curated slice like "VC" or "MCP").

## Data Model (key tables)

- **people**: name, linkedin_id, company, title, location, summary, embedding
- **social_connections**: from_person to_person, relationship_type, score
- **mutual_fits**: person pairs with complementarity_score, similarity_score, icebreakers
- **people_features**: extracted features per person (skills, interests, etc.)

## Query Patterns

- "Who should I approach about X?" - `meshi_search_contacts` + `meshi_get_mutual_fits`
- "Who are my best contacts at Company Y?" - `meshi_get_contacts` with company filter
- "Tell me about [person]" - `meshi_search_contacts` then `meshi_get_person_details`
- "Who can introduce me to X?" - `meshi_find_introduction_path` for direct paths
- "Find me someone in AI" - `meshi_search_contacts` (semantic when /sync'd)
- "Who are my strongest connections?" - `meshi_strongest_connections` for ranked relationships

## Public profile links (preferred over raw UUIDs)

When presenting results to the user, prefer **Meshi public profile pages** instead of showing raw UUIDs.

Link format (short):

`https://agent.meshi.io/m/<FROM_PERSON_ID>/<TARGET_PERSON_ID>`

(Optional: add `?direction=target` only if you need that behavior.)

- `<FROM_PERSON_ID>` is the user (viewer) id.
- `<TARGET_PERSON_ID>` is the person being viewed.

If the user provides their Meshi link once, you can reuse the same `<FROM_PERSON_ID>` for subsequent links.

## Response Guidelines

- Always include the person's name, company, and title in results
- Prefer **public profile links** over printing `person_id`/UUIDs inline (UUIDs can appear inside the link)
- When showing mutual fits, explain the icebreaker suggestions
- For "who should I approach" questions, rank by mutual_fit scores
- Be concise - show top 5 results unless asked for more
- If a search returns a `person_id`, use `meshi_get_person_details` for the full profile
