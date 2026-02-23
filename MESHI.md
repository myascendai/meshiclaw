# MeshiClaw

Chat with your professional network via Telegram. Ask questions like "Who should I approach about fundraising?" or "Who are my best contacts at Google?" and get answers powered by Meshi's network intelligence database.

MeshiClaw is built on [OpenClaw](https://github.com/openclaw/openclaw) — a multi-channel AI gateway — with a custom plugin that connects to your Meshi Supabase database.

## Quick Start

```bash
pnpm install
pnpm meshi
```

The setup wizard will prompt for:

| Variable                                                                       | Description                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `MESHI_SUPABASE_URL`                                                           | Your Meshi Supabase project URL                                                                 |
| `MESHI_SUPABASE_KEY`                                                           | Supabase service-role or anon key                                                               |
| `MESHI_USER_ID`                                                                | Your person UUID in the Meshi database                                                          |
| `TELEGRAM_BOT_TOKEN`                                                           | Telegram bot token from [@BotFather](https://t.me/BotFather)                                    |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `CEREBRAS_API_KEY` | LLM provider API key (see [Model Providers](https://docs.openclaw.ai/concepts/model-providers)) |

If these are already set as environment variables, the wizard will use them automatically.

After setup, the gateway starts and your Telegram bot is live. Open Telegram and start chatting.

## Manual Setup

If you prefer to configure manually instead of using the wizard:

1. Copy the template:

   ```bash
   cp meshiclaw.config.template.json5 ~/.openclaw/openclaw.json
   ```

2. Fill in your values in `~/.openclaw/openclaw.json`.

3. Create a `.env` file at the repo root:

   ```
   MESHI_SUPABASE_URL=https://xxx.supabase.co
   MESHI_SUPABASE_KEY=eyJ...
   MESHI_USER_ID=your-person-uuid
   TELEGRAM_BOT_TOKEN=123:ABC...
   # Pick one provider (see https://docs.openclaw.ai/concepts/model-providers)
   ANTHROPIC_API_KEY=sk-ant-...
   # or
   OPENAI_API_KEY=sk-...
   # or
   GEMINI_API_KEY=...
   # or
   CEREBRAS_API_KEY=...
   ```

4. Launch the gateway:

   ```bash
   pnpm meshi:gateway
   ```

## Rate limits and model fallback

If you see **"API rate limit reached"** in logs, OpenClaw can automatically try cheaper fallback models. The setup wizard (`pnpm meshi` / `node scripts/meshi-setup.mjs`) writes `agents.defaults.model.primary` and `agents.defaults.model.fallbacks` so that on rate limit or auth failure the agent tries the next model in the list instead of failing.

To enable or change fallbacks manually, set in `~/.openclaw/openclaw.json`:

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "anthropic/claude-sonnet-4-5",
      "fallbacks": ["anthropic/claude-sonnet-4-6", "anthropic/claude-3-5-haiku-20241022"]
    }
  }
}
```

Use cheaper or lighter models in `fallbacks` (e.g. Sonnet → Haiku, GPT-5 → GPT-5-mini) to reduce rate-limit errors. See [Model failover](https://docs.openclaw.ai/concepts/model-failover) and [Models CLI](https://docs.openclaw.ai/concepts/models).

## What You Can Ask

| Question                                   | What happens                                       |
| ------------------------------------------ | -------------------------------------------------- |
| "Who are my best contacts?"                | Fetches your contacts ranked by relationship score |
| "Who should I approach about fundraising?" | Searches your network + ranks by mutual fit scores |
| "Tell me about Jane Smith"                 | Looks up a person's full profile and connections   |
| "Who are my contacts at Sequoia?"          | Filters contacts by company                        |
| "Who can introduce me to John Doe?"        | Searches for John, then finds shared connections   |

## Architecture

```
Telegram ──► OpenClaw Gateway
               ├── Agent + Meshi Skill (always-injected context)
               ├── meshi_search_people    ─┐
               ├── meshi_get_contacts      │──► Meshi Supabase DB
               ├── meshi_get_mutual_fits   │
               └── meshi_get_person_details┘
```

### Components

- **`extensions/meshi/`** — OpenClaw plugin that registers 4 tools with the agent
- **`skills/meshi-network/SKILL.md`** — Always-injected skill that teaches the agent about Meshi's data model and query patterns
- **`scripts/meshi-setup.mjs`** — Interactive one-command setup wizard

### Tools

| Tool                       | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `meshi_search_people`      | Semantic search across the network by name, company, title, or keywords |
| `meshi_get_contacts`       | List contacts with relationship scores, filterable by name/company      |
| `meshi_get_mutual_fits`    | Get compatibility scores and icebreaker suggestions between people      |
| `meshi_get_person_details` | Full profile for one person including their connections                 |

### Database Tables Used

| Table                | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `people`             | Name, company, title, location, summary, embedding             |
| `social_connections` | Directed edges between people with relationship type and score |
| `mutual_fits`        | Pairwise compatibility scores with icebreaker suggestions      |
| `people_features`    | Extracted skills, interests, and other features per person     |

### Supabase RPCs

| RPC                                        | Used by                                        |
| ------------------------------------------ | ---------------------------------------------- |
| `find_topk_within_scope`                   | `meshi_search_people` — semantic vector search |
| `get_contacts_for_from_person_search_v2`   | `meshi_get_contacts` — paginated contacts      |
| `get_people_with_mutual_fits_paginated_v2` | `meshi_get_mutual_fits` — mutual fit scores    |

## File Structure

```
extensions/meshi/
├── index.ts                  # Plugin entry point
├── package.json              # Dependencies (@supabase/supabase-js)
├── openclaw.plugin.json      # Plugin manifest
└── src/
    ├── supabase-client.ts    # Supabase connection wrapper
    └── tools.ts              # 4 agent tool factories

skills/meshi-network/
└── SKILL.md                  # Always-injected agent context

scripts/
└── meshi-setup.mjs           # One-command setup wizard

meshiclaw.config.template.json5  # Config template
```

## Requirements

- Node.js >= 22
- pnpm
- A Meshi Supabase database with populated `people`, `social_connections`, and `mutual_fits` tables
- A Telegram bot token
- An LLM provider API key supported by OpenClaw (for example Anthropic, OpenAI, Google Gemini, or Cerebras; see https://docs.openclaw.ai/concepts/model-providers)
