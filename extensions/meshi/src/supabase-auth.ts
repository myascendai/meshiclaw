import { createClient } from "@supabase/supabase-js";

type OtpOk = { ok: true };
type OtpFail = { ok: false; error: string };

type VerifyOk = {
  ok: true;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export async function sendOtp(
  supabaseUrl: string,
  supabaseKey: string,
  email: string,
): Promise<OtpOk | OtpFail> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: false },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function verifyOtp(
  supabaseUrl: string,
  supabaseKey: string,
  email: string,
  code: string,
): Promise<VerifyOk | OtpFail> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: code.trim(),
    type: "email",
  });
  if (error) return { ok: false, error: error.message };
  if (!data.session || !data.user) return { ok: false, error: "No session returned" };
  return {
    ok: true,
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? 0,
  };
}
