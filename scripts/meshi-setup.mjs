#!/usr/bin/env node
/**
 * MeshiClaw One-Command Setup
 *
 * Interactive setup that:
 * 1. Checks Node.js version
 * 2. Installs deps if needed
 * 3. Picks model provider + model
 * 4. Collects config (from .env / env or prompts)
 * 5. Writes ~/.openclaw/openclaw.json + .env
 * 6. Launches the gateway
 */

import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");
const ENV_PATH = path.join(ROOT, ".env");

const accent = chalk.hex("#ff6b35");
const soft = chalk.hex("#ffa07a");
const dim = chalk.dim;

// ---------------------------------------------------------------------------
// Provider / model definitions
// ---------------------------------------------------------------------------

const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "most capable" },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", hint: "balanced" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "fast + smart" },
    ],
    // Cheaper same-provider options (used first).
    sameProviderFallbacks: ["claude-sonnet-4-6", "claude-sonnet-4-5"],
  },
  openai: {
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      { value: "gpt-5.2", label: "GPT-5.2", hint: "flagship" },
      { value: "gpt-5-mini", label: "GPT-5 Mini", hint: "fast + cheap" },
    ],
    sameProviderFallbacks: ["gpt-5-mini"],
  },
  google: {
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    models: [
      { value: "gemini-3-pro-preview", label: "Gemini 3 Pro", hint: "most capable" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "fast" },
    ],
    sameProviderFallbacks: ["gemini-3-flash-preview"],
  },
  cerebras: {
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    models: [
      { value: "gpt-oss-120b", label: "GPT OSS 120B", hint: "production" },
      { value: "llama3.1-8b", label: "Llama 3.1 8B", hint: "fast" },
      { value: "zai-glm-4.7", label: "Z.ai GLM 4.7 (preview)", hint: "if you have access" },
    ],
    sameProviderFallbacks: ["llama3.1-8b", "zai-glm-4.7"],
  },
  mistral: {
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    models: [
      { value: "mistral-large-latest", label: "Mistral Large", hint: "most capable" },
      { value: "mistral-small-latest", label: "Mistral Small", hint: "fast" },
    ],
    sameProviderFallbacks: ["mistral-small-latest"],
  },
};

// Cross-provider cheap fallbacks (used after same-provider options).
// Order is from cheaper / lighter to heavier, to reduce API spend.
const CROSS_PROVIDER_CHEAP_FALLBACKS = [
  "openai/gpt-5-mini",
  "google/gemini-3-flash-preview",
  "mistral/mistral-small-latest",
  "cerebras/llama3.1-8b",
];

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function banner() {
  const line = dim("\u2500".repeat(52));
  console.log();
  console.log(line);
  console.log(
    accent.bold("  \u{1F35C}  MeshiClaw"),
    dim("\u2014"),
    soft.italic("one-command setup"),
  );
  console.log(line);
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkNodeVersion() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    p.cancel(
      chalk.red("Node.js >= 22 required") +
        dim(` (found ${process.versions.node})\n`) +
        dim("  Install via: https://nodejs.org or nvm install 22"),
    );
    process.exit(1);
  }
  p.log.info(dim(`Node.js ${process.versions.node}`));
}

function ensureDeps() {
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
    const s = p.spinner();
    s.start("Installing dependencies");
    execSync("pnpm install", { cwd: ROOT, stdio: "ignore" });
    s.stop("Dependencies installed");
  }
}

/** Parse the existing .env file into a key-value map. */
function loadEnvFile() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) {
    return env;
  }
  const content = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

/** Show first 6 + ... + last 4 for secrets. */
function mask(value) {
  if (value.length <= 12) {
    return dim("\u2022".repeat(8));
  }
  return soft(value.slice(0, 6)) + dim("...") + soft(value.slice(-4));
}

function cancelled() {
  p.cancel(chalk.yellow("Setup cancelled."));
  process.exit(0);
}

/** Return value from .env file, process.env, or prompt the user. */
async function resolve(envFile, envKey, label, secret = false) {
  const existing = envFile[envKey] ?? process.env[envKey];
  if (existing) {
    const display = secret
      ? mask(existing)
      : soft(existing.slice(0, 44) + (existing.length > 44 ? "\u2026" : ""));
    p.log.success(`${chalk.bold(envKey)} ${dim("\u2192")} ${display}`);
    return existing;
  }
  const value = await p.text({
    message: label,
    placeholder: envKey,
    validate: (v) => (v.trim() ? undefined : `${envKey} is required`),
  });
  if (p.isCancel(value)) {
    cancelled();
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner();
  p.intro(accent("Let's get you set up"));

  checkNodeVersion();
  ensureDeps();

  const envFile = loadEnvFile();
  const hasEnv = Object.keys(envFile).length > 0;

  if (hasEnv) {
    p.log.step(dim("Loading existing .env values\u2026"));
  } else {
    p.log.step("No .env found \u2014 we'll collect everything now.");
  }

  // ---- Model provider ----

  let providerChoice = envFile.MESHI_PROVIDER;
  if (providerChoice && PROVIDERS[providerChoice]) {
    p.log.success(
      `${chalk.bold("MESHI_PROVIDER")} ${dim("\u2192")} ${soft(PROVIDERS[providerChoice].label)}`,
    );
  } else {
    providerChoice = await p.select({
      message: "Model provider",
      options: Object.entries(PROVIDERS).map(([value, { label }]) => ({
        value,
        label,
      })),
      initialValue: "anthropic",
    });
    if (p.isCancel(providerChoice)) {
      cancelled();
    }
  }

  const provider = PROVIDERS[providerChoice];

  // ---- Model ----

  let modelChoice = envFile.MESHI_MODEL;
  if (modelChoice && provider.models.some((m) => m.value === modelChoice)) {
    p.log.success(`${chalk.bold("MESHI_MODEL")} ${dim("\u2192")} ${soft(modelChoice)}`);
  } else {
    modelChoice = await p.select({
      message: `Model ${dim(`(${provider.label})`)}`,
      options: provider.models.map(({ value, label, hint }) => ({
        value,
        label,
        hint,
      })),
    });
    if (p.isCancel(modelChoice)) {
      cancelled();
    }
  }

  const modelRef = `${providerChoice}/${modelChoice}`;

  // ---- Provider API key (primary) ----

  console.log();
  const providerApiKey = await resolve(envFile, provider.envKey, `${provider.label} API Key`, true);

  // Providers that have an API token (primary from prompt, others from .env / process.env).
  const validProviderIds = new Set([providerChoice]);
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (id === providerChoice) {
      continue;
    }
    const key = envFile[def.envKey] ?? process.env[def.envKey];
    if (key && String(key).trim()) {
      validProviderIds.add(id);
    }
  }

  // Build selectable fallback options (only for valid providers, exclude primary).
  function modelRefLabel(ref) {
    const [provId, modelId] = ref.split("/");
    const def = PROVIDERS[provId];
    if (!def) {
      return ref;
    }
    const model = def.models?.find((m) => m.value === modelId);
    const modelLabel = model?.label ?? modelId;
    return `${def.label} ${modelLabel}`;
  }

  // Curated fallback options: same-provider + cross-provider cheap models (only valid providers).
  const sameProviderRefs = (provider.sameProviderFallbacks ?? [])
    .filter((id) => id !== modelChoice)
    .map((id) => `${providerChoice}/${id}`);
  const crossProviderRefs = CROSS_PROVIDER_CHEAP_FALLBACKS.filter((ref) => {
    if (ref === modelRef || ref.startsWith(`${providerChoice}/`)) {
      return false;
    }
    return validProviderIds.has(ref.split("/")[0]);
  });
  const uniqueCandidates = Array.from(new Set([...sameProviderRefs, ...crossProviderRefs]));

  let fallbackRefs = [];
  if (uniqueCandidates.length > 0) {
    p.log.step(dim("Model fallbacks (for rate limits)"));
    const enableFallbacks = await p.confirm({
      message: "Enable fallback models when the primary hits rate limits?",
      initialValue: true,
    });
    if (p.isCancel(enableFallbacks)) {
      cancelled();
    }
    if (enableFallbacks) {
      const selected = await p.multiselect({
        message: "Select fallback models (tried in this order)",
        options: uniqueCandidates.map((ref) => ({
          value: ref,
          label: modelRefLabel(ref),
          hint: ref.startsWith(providerChoice) ? "same provider" : "other provider",
        })),
        required: false,
      });
      if (p.isCancel(selected)) {
        cancelled();
      }
      fallbackRefs = Array.isArray(selected) ? selected : [];
    }
  }

  if (fallbackRefs.length > 0) {
    p.log.info(
      `Agent model ${dim("\u2192")} ${accent.bold(modelRef)} ${dim("(fallbacks:")} ${fallbackRefs.join(", ")}${dim(")")}`,
    );
  } else {
    p.log.info(`Agent model ${dim("\u2192")} ${accent.bold(modelRef)}`);
  }

  // ---- Meshi / Supabase ----

  p.log.step(dim("Meshi network config"));

  const supabaseUrl = await resolve(envFile, "MESHI_SUPABASE_URL", "Supabase project URL");
  const supabaseKey = await resolve(
    envFile,
    "MESHI_SUPABASE_KEY",
    `Supabase ${chalk.bold("anon")} key ${dim("(public, not service_role)")}`,
    true,
  );

  // ---- Telegram ----

  p.log.step(dim("Telegram channel"));

  const telegramToken = await resolve(envFile, "TELEGRAM_BOT_TOKEN", "Telegram Bot Token", true);

  // ---- Gateway auth token ----

  const existingToken = envFile.OPENCLAW_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const gatewayToken = existingToken || crypto.randomUUID();
  if (existingToken) {
    p.log.success(`${chalk.bold("OPENCLAW_GATEWAY_TOKEN")} ${dim("\u2192")} ${mask(gatewayToken)}`);
  } else {
    p.log.success(`${chalk.bold("OPENCLAW_GATEWAY_TOKEN")} ${dim("\u2192")} ${dim("generated")}`);
  }

  // ---- Write .env ----

  const mergedEnv = {
    ...envFile,
    MESHI_PROVIDER: providerChoice,
    MESHI_MODEL: modelChoice,
    MESHI_SUPABASE_URL: supabaseUrl,
    MESHI_SUPABASE_KEY: supabaseKey,
    TELEGRAM_BOT_TOKEN: telegramToken,
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    [provider.envKey]: providerApiKey,
  };
  // Preserve API keys for any other provider present in env (for fallbacks).
  for (const [id, def] of Object.entries(PROVIDERS)) {
    if (id === providerChoice) {
      continue;
    }
    const v = process.env[def.envKey] ?? envFile[def.envKey];
    if (v && String(v).trim()) {
      mergedEnv[def.envKey] = v;
    }
  }

  const envLines = Object.entries(mergedEnv).map(([key, value]) => `${key}=${value}`);

  fs.writeFileSync(ENV_PATH, `${envLines.join("\n")}\n`, "utf8");
  p.log.success(`Wrote ${chalk.underline(ENV_PATH)}`);

  // Also write to ~/.openclaw/.env so OpenClaw (doctor, gateway) finds keys when run from any cwd.
  const stateEnvPath = path.join(STATE_DIR, ".env");
  let stateEnv = {};
  if (fs.existsSync(stateEnvPath)) {
    try {
      const raw = fs.readFileSync(stateEnvPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) {
          continue;
        }
        stateEnv[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    } catch {
      // ignore
    }
  }
  const stateEnvMerged = { ...stateEnv, ...mergedEnv };
  const stateEnvLines = Object.entries(stateEnvMerged).map(([k, v]) => `${k}=${v}`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateEnvPath, `${stateEnvLines.join("\n")}\n`, "utf8");
  try {
    fs.chmodSync(stateEnvPath, 0o600);
  } catch {}
  p.log.success(`Wrote ${chalk.underline(stateEnvPath)} ${dim("(for openclaw from any cwd)")}`);

  // ---- Write openclaw.json config ----

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {} // fix existing dir

  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      // ignore parse errors, overwrite
    }
  }

  const merged = {
    ...existing,
    gateway: {
      ...existing.gateway,
      mode: "local",
      auth: { mode: "token", token: gatewayToken },
    },
    session: { ...existing.session, dmScope: "per-channel-peer" },
    agents: {
      ...existing.agents,
      defaults: {
        ...existing.agents?.defaults,
        model: {
          primary: modelRef,
          ...(fallbackRefs.length > 0 ? { fallbacks: fallbackRefs } : {}),
        },
      },
    },
    channels: {
      ...existing.channels,
      telegram: {
        botToken: telegramToken,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  };

  // Strip keys that older OpenClaw npm releases reject as "Unrecognized" so doctor --fix passes.
  if (merged.commands && typeof merged.commands === "object") {
    delete merged.commands.ownerDisplay;
    delete merged.commands.ownerDisplaySecret;
  }
  if (merged.channels?.telegram && typeof merged.channels.telegram === "object") {
    delete merged.channels.telegram.streaming;
  }

  // Re-assign for models block below (merged was closed above).
  const extensionsPath = path.join(ROOT, "extensions");
  const existingPaths = Array.isArray(existing.plugins?.load?.paths)
    ? existing.plugins.load.paths
    : [];
  const loadPaths = existingPaths.includes(extensionsPath)
    ? existingPaths
    : [extensionsPath, ...existingPaths];

  Object.assign(merged, {
    plugins: {
      ...existing.plugins,
      load: { ...existing.plugins?.load, paths: loadPaths },
      entries: {
        ...existing.plugins?.entries,
        meshi: {
          enabled: true,
          config: {
            supabaseUrl,
            supabaseKey,
          },
        },
      },
    },
    skills: {
      ...existing.skills,
      entries: {
        ...existing.skills?.entries,
        "meshi-network": {
          enabled: true,
        },
      },
    },
    models:
      providerChoice === "cerebras"
        ? {
            ...existing.models,
            mode: existing.models?.mode ?? "merge",
            providers: {
              ...existing.models?.providers,
              cerebras: {
                baseUrl: "https://api.cerebras.ai/v1",
                apiKey: "${CEREBRAS_API_KEY}",
                api: "openai-completions",
                models: [
                  { id: "gpt-oss-120b", name: "GPT OSS 120B" },
                  { id: "llama3.1-8b", name: "Llama 3.1 8B" },
                  { id: "zai-glm-4.7", name: "Z.ai GLM 4.7 (preview)" },
                ],
              },
            },
          }
        : existing.models,
  });

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  p.log.success(`Wrote ${chalk.underline(CONFIG_PATH)}`);
  if (fallbackRefs.length > 0) {
    p.log.info(dim(`Fallbacks: ${fallbackRefs.length} model(s) (tried in order on rate limit)`));
  }

  // ---- Kill existing gateway on port ----

  const GATEWAY_PORT = 18789;
  try {
    const pids =
      process.platform === "win32"
        ? execSync(`netstat -ano | findstr :${GATEWAY_PORT} | findstr LISTENING`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
            .split("\n")
            .map((l) => l.trim().split(/\s+/).pop())
            .filter(Boolean)
            .filter((v) => v !== "0")
        : execSync(`lsof -ti :${GATEWAY_PORT}`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
            .trim()
            .split("\n")
            .filter(Boolean);

    if (pids.length) {
      const unique = [...new Set(pids)];
      for (const pid of unique) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      p.log.warn(
        `Killed existing process on port ${GATEWAY_PORT} ${dim(`(pid ${unique.join(", ")})`)}`,
      );
      // Give it a moment to release the port
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // No process on port — good
  }

  // ---- Launch gateway ----

  console.log();
  p.outro(accent.bold("Launching gateway") + " " + dim(`\u00b7 ${modelRef} \u00b7 Ctrl+C to stop`));

  const gateway = spawn("node", ["scripts/run-node.mjs", "gateway"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      MESHI_SUPABASE_URL: supabaseUrl,
      MESHI_SUPABASE_KEY: supabaseKey,
      TELEGRAM_BOT_TOKEN: telegramToken,
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      [provider.envKey]: providerApiKey,
    },
  });

  gateway.on("error", (err) => {
    console.error(chalk.red.bold("\n  Gateway failed: ") + chalk.red(err.message));
    process.exit(1);
  });

  gateway.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
