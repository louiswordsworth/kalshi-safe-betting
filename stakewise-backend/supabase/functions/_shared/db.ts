// Database access + request helpers shared by every edge function.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { classifyWithRules, merchantKey } from "./detect.ts";
import type { Classification, Limits, Transaction } from "./types.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

/** Signed-in user from the JWT, or the seeded demo user when DEMO_MODE=true. */
export async function resolveUserId(req: Request, db: SupabaseClient): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token) {
    const { data } = await db.auth.getUser(token);
    if (data?.user) return data.user.id;
  }
  return Deno.env.get("DEMO_MODE") === "true" ? (Deno.env.get("DEMO_USER_ID") ?? DEMO_USER_ID) : null;
}

/** "Today" for the demo can be pinned so the story is the same every run. */
export function today(): string {
  return Deno.env.get("DEMO_TODAY") ?? new Date().toISOString().slice(0, 10);
}

export interface UserContext {
  userId: string;
  firstName: string;
  language: string;
  plainLanguage: boolean;
  balance: number;
  transactions: Transaction[];
  classifications: Classification[];
  feedback: Record<string, boolean>;
  limits: Limits;
}

export async function loadContext(db: SupabaseClient, userId: string): Promise<UserContext> {
  const since = new Date(Date.parse(today()) - 120 * 86_400_000).toISOString();
  const [profile, txs, stored, fb, lim] = await Promise.all([
    db.from("profiles").select("*").eq("id", userId).single(),
    db.from("transactions").select("id,user_id,posted_at,amount,description,mcc").eq("user_id", userId)
      .gte("posted_at", since).lte("posted_at", today() + "T23:59:59Z").order("posted_at"),
    db.from("classifications").select("*").eq("user_id", userId),
    db.from("merchant_feedback").select("merchant_key,is_gambling").eq("user_id", userId),
    db.from("limits").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  if (profile.error) throw new Error(`Profile not found: ${profile.error.message}`);

  const transactions = (txs.data ?? []).map((t) => ({ ...t, amount: Number(t.amount) })) as Transaction[];
  const feedback: Record<string, boolean> = {};
  for (const f of fb.data ?? []) feedback[f.merchant_key] = f.is_gambling;

  // Fresh rules pass, then overlay stored LLM results (user feedback is applied by the rules pass)
  const rules = classifyWithRules(transactions, feedback);
  const storedById = new Map((stored.data ?? []).map((c) => [c.transaction_id, c]));
  const classifications = rules.map((r) => {
    const s = storedById.get(r.transaction_id);
    return s && s.source === "llm" && r.source !== "user"
      ? { ...r, label: s.label, confidence: Number(s.confidence), reasons: s.reasons, source: "llm" as const }
      : r;
  });

  // Apply any limit increase whose 48h cooling-off has passed
  let limits = lim.data as (Limits & { pending_increase: Record<string, number> | null; pending_effective_at: string | null }) | null;
  if (limits?.pending_increase && limits.pending_effective_at && Date.parse(limits.pending_effective_at) <= Date.now()) {
    const { data } = await db.from("limits")
      .update({ ...limits.pending_increase, pending_increase: null, pending_effective_at: null })
      .eq("user_id", userId).select().single();
    limits = data;
  }

  return {
    userId,
    firstName: profile.data.first_name ?? "there",
    language: profile.data.language ?? "English",
    plainLanguage: profile.data.plain_language ?? true,
    balance: Number(profile.data.current_balance),
    transactions,
    classifications,
    feedback,
    limits: {
      weekly_gambling_limit: limits?.weekly_gambling_limit ?? null,
      per_bet_max: limits?.per_bet_max ?? null,
      self_exclusion_until: limits?.self_exclusion_until ?? null,
    },
  };
}

export async function saveClassifications(db: SupabaseClient, userId: string, cs: Classification[]) {
  const rows = cs.filter((c) => c.source !== "rules" || c.confidence > 0.05).map((c) => ({
    transaction_id: c.transaction_id, user_id: userId, label: c.label, category: c.category,
    confidence: c.confidence, reasons: c.reasons, source: c.source, updated_at: new Date().toISOString(),
  }));
  if (rows.length) await db.from("classifications").upsert(rows, { onConflict: "transaction_id" });
}

export { merchantKey };
