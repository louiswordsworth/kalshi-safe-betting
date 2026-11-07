// POST /classify-transactions
// Runs rules + behaviour signals over the user's transactions, asks the LLM to weigh in on
// ambiguous ones, stores the results, and returns the items we should ask the user about.
import { admin, corsHeaders, json, loadContext, resolveUserId, saveClassifications } from "../_shared/db.ts";
import { mergeLlm, THRESHOLDS } from "../_shared/detect.ts";
import { chatJson, llmConfigured } from "../_shared/llm.ts";

const SYSTEM = `You review UK bank transactions to spot money likely going to gambling or prediction
markets (Kalshi, Polymarket, etc.), including routes that dodge bank gambling blocks: crypto top-ups,
e-wallets and international transfers. You get descriptions, amounts, times and rule-based signals only.
For each item return a probability (0-1) that it is gambling/speculation funding and a short reason
(max 15 words). Be cautious: ordinary crypto investing exists, so frequency, timing, escalation and
round amounts matter. Return JSON {"items":[{"i":number,"p":number,"reason":string}]}.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = admin();
    const userId = await resolveUserId(req, db);
    if (!userId) return json({ error: "Not signed in" }, 401);
    const ctx = await loadContext(db, userId);

    let cs = ctx.classifications;
    const ambiguous = cs
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => c.source === "rules" && c.confidence >= 0.15 && c.confidence < 0.95);

    let aiUsed = false;
    if (ambiguous.length && llmConfigured()) {
      const byId = new Map(ctx.transactions.map((t) => [t.id, t]));
      // Data minimisation: no IDs, account numbers or names go to the model.
      const items = ambiguous.slice(0, 40).map(({ c }, i) => {
        const t = byId.get(c.transaction_id)!;
        return { i, description: t.description, amount_gbp: Math.abs(t.amount), time: t.posted_at, signals: c.reasons };
      });
      const out = await chatJson<{ items: { i: number; p: number; reason: string }[] }>(SYSTEM, JSON.stringify(items));
      if (out?.items) {
        aiUsed = true;
        cs = [...cs];
        for (const r of out.items) {
          const target = ambiguous[r.i];
          if (!target || typeof r.p !== "number") continue;
          cs[target.idx] = mergeLlm(target.c, Math.max(0, Math.min(1, r.p)), r.reason);
        }
      }
    }

    await saveClassifications(db, userId, cs);

    const byId = new Map(ctx.transactions.map((t) => [t.id, t]));
    const enrich = (c: (typeof cs)[number]) => ({ ...c, transaction: byId.get(c.transaction_id) });
    return json({
      ai_used: aiUsed,
      summary: {
        gambling: cs.filter((c) => c.label === "gambling").length,
        ask_user: cs.filter((c) => c.label === "ask_user").length,
        total: cs.length,
      },
      thresholds: THRESHOLDS,
      questions: cs.filter((c) => c.label === "ask_user").map(enrich), // "Was this top-up for betting?"
      flagged: cs.filter((c) => c.label === "gambling").map(enrich),
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
