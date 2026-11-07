// POST /feedback  { "transaction_id": "...", "is_gambling": true }
// The user's answer always wins and applies to every transaction from the same merchant.
import { admin, corsHeaders, json, merchantKey, resolveUserId } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = admin();
    const userId = await resolveUserId(req, db);
    if (!userId) return json({ error: "Not signed in" }, 401);
    const { transaction_id, is_gambling } = await req.json();
    if (!transaction_id || typeof is_gambling !== "boolean") {
      return json({ error: "transaction_id and is_gambling (boolean) are required" }, 400);
    }

    const { data: tx, error } = await db.from("transactions").select("description")
      .eq("id", transaction_id).eq("user_id", userId).single();
    if (error || !tx) return json({ error: "Transaction not found" }, 404);

    const key = merchantKey(tx.description);
    await db.from("merchant_feedback").upsert(
      { user_id: userId, merchant_key: key, is_gambling, updated_at: new Date().toISOString() },
      { onConflict: "user_id,merchant_key" },
    );
    // Drop stored AI opinions for this merchant so the user's answer takes over everywhere
    const { data: all } = await db.from("transactions").select("id,description").eq("user_id", userId);
    const ids = (all ?? []).filter((r) => merchantKey(r.description) === key).map((r) => r.id);
    if (ids.length) await db.from("classifications").delete().in("transaction_id", ids);

    return json({ ok: true, merchant_key: key, is_gambling, transactions_updated: ids.length });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
