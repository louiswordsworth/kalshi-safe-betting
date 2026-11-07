// POST /forecast  { "weekly_cap": 15 (optional), "extra_outflow": 0, "horizon_days": 35 }
// Returns the baseline forecast and, if weekly_cap is given, the "what if" scenario too,
// so the UI can draw both bands and show the line recovering.
import { admin, corsHeaders, json, loadContext, resolveUserId, today } from "../_shared/db.ts";
import { forecast } from "../_shared/forecast.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = admin();
    const userId = await resolveUserId(req, db);
    if (!userId) return json({ error: "Not signed in" }, 401);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const ctx = await loadContext(db, userId);

    const input = {
      transactions: ctx.transactions,
      classifications: ctx.classifications,
      startingBalance: ctx.balance,
      asOf: today(),
      horizonDays: Number(body.horizon_days ?? 35),
      extraOutflowToday: Number(body.extra_outflow ?? 0),
    };
    const baseline = forecast(input);
    const scenario = body.weekly_cap !== undefined && body.weekly_cap !== null
      ? forecast({ ...input, gamblingWeeklyCap: Number(body.weekly_cap) })
      : null;

    return json({ baseline, scenario });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
