// GET  /limits                        -> current limits (+ any pending increase)
// POST /limits { "weekly_gambling_limit": 15, "per_bet_max": 10, "pause_hours": 48 }
// Lowering a limit or pausing applies immediately. Raising a limit waits 48 hours (cooling-off).
import { admin, corsHeaders, json, nowUtc, resolveUserId } from "../_shared/db.ts";

const COOLING_OFF_HOURS = 48;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = admin();
    const userId = await resolveUserId(req, db);
    if (!userId) return json({ error: "Not signed in" }, 401);

    const { data: current } = await db.from("limits").select("*").eq("user_id", userId).maybeSingle();
    if (req.method === "GET") return json({ limits: current });

    const body = await req.json();
    const now = nowUtc();
    const immediate: Record<string, unknown> = {};
    const pending: Record<string, number> = {};

    for (const field of ["weekly_gambling_limit", "per_bet_max"] as const) {
      if (body[field] === undefined) continue;
      const next = body[field] === null ? null : Number(body[field]);
      const prev = current?.[field] ?? null;
      const isIncrease = next === null ? prev !== null : prev !== null && next > prev;
      if (isIncrease) pending[field] = next as number;
      else immediate[field] = next;
    }
    if (body.pause_hours !== undefined) {
      const pauseHours = Number(body.pause_hours);
      if (!Number.isFinite(pauseHours) || pauseHours <= 0) {
        return json({ error: "pause_hours must be a positive finite number" }, 400);
      }

      const requestedUntil = new Date(now.getTime() + pauseHours * 3_600_000);
      if (!Number.isFinite(requestedUntil.getTime())) {
        return json({ error: "pause_hours is outside the supported range" }, 400);
      }

      const currentPauseUntil = Date.parse(current?.self_exclusion_until ?? "");
      const effectiveUntil = Number.isFinite(currentPauseUntil) && currentPauseUntil > requestedUntil.getTime()
        ? new Date(currentPauseUntil)
        : requestedUntil;
      immediate.self_exclusion_until = effectiveUntil.toISOString();
    }

    const row: Record<string, unknown> = { user_id: userId, ...immediate, updated_at: now.toISOString() };
    if (Object.keys(pending).length) {
      row.pending_increase = pending;
      row.pending_effective_at = new Date(now.getTime() + COOLING_OFF_HOURS * 3_600_000).toISOString();
    }
    const { data, error } = await db.from("limits").upsert(row, { onConflict: "user_id" }).select().single();
    if (error) throw error;

    return json({
      limits: data,
      applied_now: Object.keys(immediate),
      cooling_off: Object.keys(pending).length
        ? { fields: Object.keys(pending), effective_at: row.pending_effective_at, hours: COOLING_OFF_HOURS }
        : null,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
