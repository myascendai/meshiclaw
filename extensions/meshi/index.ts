import { createClient } from "@supabase/supabase-js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  getAuthEntry,
  setAuthEntry,
  removeAuthEntry,
  setPendingOtp,
  getPendingOtp,
  clearPendingOtp,
} from "./src/auth-store.js";
import { extractTelegramUserId } from "./src/session-utils.js";
import { sendOtp, verifyOtp } from "./src/supabase-auth.js";
import { createMeshiTools } from "./src/tools.js";

type MeshiPluginConfig = {
  supabaseUrl?: string;
  supabaseKey?: string;
  meshiUserId?: string;
};

function isValidEmail(email: string): boolean {
  const at = email.indexOf("@");
  return at > 0 && email.indexOf(".", at) > at + 1 && !email.includes(" ");
}

// Tracks senderIds whose next outgoing message should pass through
// (command responses for /login, /verify, /logout).
const allowNextResponse = new Set<string>();

const plugin = {
  id: "meshi",
  name: "Meshi Network Intelligence",
  description: "Query Meshi's professional network intelligence database",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        supabaseUrl: { type: "string" },
        supabaseKey: { type: "string" },
        meshiUserId: { type: "string", description: "Deprecated: resolved via /login" },
      },
    },
  },
  register(api: OpenClawPluginApi) {
    for (const toolFactory of createMeshiTools()) {
      api.registerTool(toolFactory);
    }

    const cfg = (api.pluginConfig ?? {}) as MeshiPluginConfig;
    const supabaseUrl = cfg.supabaseUrl ?? process.env.MESHI_SUPABASE_URL;
    const supabaseKey = cfg.supabaseKey ?? process.env.MESHI_SUPABASE_KEY;

    // ----- /login <email> -----
    api.registerCommand({
      name: "login",
      description: "Log in to Meshi with your email. Usage: /login you@example.com",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const senderId = ctx.senderId;
        if (senderId) allowNextResponse.add(senderId);

        const email = ctx.args?.trim();
        if (!email || !isValidEmail(email)) {
          return { text: "Please provide a valid email.\nUsage: /login you@example.com" };
        }
        if (!supabaseUrl || !supabaseKey) {
          return { text: "Meshi is not configured. Contact the administrator." };
        }
        if (!senderId) {
          return { text: "Could not identify your user ID." };
        }

        const result = await sendOtp(supabaseUrl, supabaseKey, email);
        if (!result.ok) {
          return { text: `Failed to send verification code: ${result.error}` };
        }

        setPendingOtp(senderId, email);
        return {
          text: `A 6-digit code has been sent to ${email}.\nUse /verify <code> to complete login.`,
        };
      },
    });

    // ----- /verify <code> -----
    api.registerCommand({
      name: "verify",
      description: "Verify your email with the 6-digit code. Usage: /verify 123456",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const senderId = ctx.senderId;
        if (senderId) allowNextResponse.add(senderId);

        const code = ctx.args?.trim();
        if (!code || !/^\d{6}$/.test(code)) {
          return { text: "Please provide the 6-digit code.\nUsage: /verify 123456" };
        }
        if (!senderId) {
          return { text: "Could not identify your user ID." };
        }
        if (!supabaseUrl || !supabaseKey) {
          return { text: "Meshi is not configured. Contact the administrator." };
        }

        const pending = getPendingOtp(senderId);
        if (!pending) {
          return { text: "No pending login. Use /login <email> first." };
        }

        const result = await verifyOtp(supabaseUrl, supabaseKey, pending.email, code);
        if (!result.ok) {
          return { text: `Verification failed: ${result.error}` };
        }

        // Resolve person_id from auth user_id
        const supabase = createClient(supabaseUrl, supabaseKey);
        const { data: personRow } = await supabase
          .from("people")
          .select("id")
          .eq("user_id", result.userId)
          .eq("status", "active")
          .limit(1)
          .single();

        if (!personRow) {
          return { text: "No Meshi profile found for this account." };
        }

        setAuthEntry(senderId, {
          email: pending.email,
          supabaseUserId: result.userId,
          personId: personRow.id,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        });
        clearPendingOtp(senderId);

        return { text: `Logged in as ${pending.email}. You can now use Meshi.` };
      },
    });

    // ----- /logout -----
    api.registerCommand({
      name: "logout",
      description: "Log out of Meshi",
      acceptsArgs: false,
      requireAuth: false,
      handler: async (ctx) => {
        const senderId = ctx.senderId;
        if (senderId) allowNextResponse.add(senderId);

        if (!senderId) {
          return { text: "Could not identify your user ID." };
        }
        removeAuthEntry(senderId);
        return { text: "Logged out. Use /login <email> to log in again." };
      },
    });

    // ----- Auth context hook -----
    api.on("before_prompt_build", (_event, ctx) => {
      const telegramUserId = extractTelegramUserId(ctx.sessionKey);
      if (!telegramUserId) return;

      const authEntry = getAuthEntry(telegramUserId);
      if (!authEntry) {
        return {
          prependContext:
            "[MESHI] The user is not authenticated. " +
            "Tell them to use /login <email> to log in before they can use Meshi network tools.",
        };
      }
      return {
        prependContext: `[MESHI] User authenticated as ${authEntry.email}.`,
      };
    });

    // ----- Block agent responses for unauthenticated Telegram users -----
    api.on("message_sending", (event, ctx) => {
      if (ctx.channelId !== "telegram") return;

      const userId = event.to;

      // Allow command responses (/login, /verify, /logout) through
      if (allowNextResponse.has(userId)) {
        allowNextResponse.delete(userId);
        return;
      }

      // Authenticated users pass through
      if (getAuthEntry(userId)) return;

      // Block agent response and replace with login prompt
      return {
        content: "Please use /login <email> to authenticate before using Meshi.",
      };
    });
  },
};

export default plugin;
