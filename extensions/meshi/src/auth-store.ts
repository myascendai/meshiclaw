import fs from "node:fs";
import path from "node:path";

const STATE_DIR = path.join(process.env.HOME ?? "~", ".openclaw");
const AUTH_FILE = path.join(STATE_DIR, "meshi-auth.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MeshiAuthEntry = {
  email: string;
  supabaseUserId: string; // auth.users.id
  personId: string; // people.id
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type AuthStore = Record<string, MeshiAuthEntry>;

type PendingOtp = {
  email: string;
  requestedAt: number;
};

// ---------------------------------------------------------------------------
// Persistent auth store (telegramUserId → Supabase auth)
// ---------------------------------------------------------------------------

function loadStore(): AuthStore {
  try {
    if (!fs.existsSync(AUTH_FILE)) return {};
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthStore;
  } catch {
    return {};
  }
}

function saveStore(store: AuthStore): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getAuthEntry(telegramUserId: string): MeshiAuthEntry | null {
  const store = loadStore();
  return store[telegramUserId] ?? null;
}

export function setAuthEntry(telegramUserId: string, entry: MeshiAuthEntry): void {
  const store = loadStore();
  store[telegramUserId] = entry;
  saveStore(store);
}

export function removeAuthEntry(telegramUserId: string): void {
  const store = loadStore();
  delete store[telegramUserId];
  saveStore(store);
}

// ---------------------------------------------------------------------------
// In-memory pending OTP map (not persisted — OTPs expire in minutes)
// ---------------------------------------------------------------------------

const pendingOtps = new Map<string, PendingOtp>();

export function setPendingOtp(telegramUserId: string, email: string): void {
  pendingOtps.set(telegramUserId, { email, requestedAt: Date.now() });
}

export function getPendingOtp(telegramUserId: string): PendingOtp | null {
  const entry = pendingOtps.get(telegramUserId);
  if (!entry) return null;
  // Expire after 10 minutes
  if (Date.now() - entry.requestedAt > 10 * 60 * 1000) {
    pendingOtps.delete(telegramUserId);
    return null;
  }
  return entry;
}

export function clearPendingOtp(telegramUserId: string): void {
  pendingOtps.delete(telegramUserId);
}
