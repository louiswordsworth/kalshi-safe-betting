// Helpers that turn detection + forecast output into coach-ready insights.
import { forecast, type ForecastInput } from "./forecast.ts";
import { THRESHOLDS } from "./detect.ts";
import type { Classification, ForecastResult, Transaction } from "./types.ts";

/** Largest weekly limit (in £5 steps) that keeps the typical balance at the big bill >= buffer
 *  and the chance of going short before it at 10% or less. */
export function suggestWeeklyLimit(input: Omit<ForecastInput, "gamblingWeeklyCap">, pace: number, buffer = 50): { limit: number; result: ForecastResult } {
  const max = Math.max(5, Math.floor(pace / 5) * 5);
  let best: { limit: number; result: ForecastResult } | null = null;
  for (let cap = 5; cap <= max; cap += 5) {
    const result = forecast({ ...input, gamblingWeeklyCap: cap }); // same default runs as the forecast endpoint, so both agree
    const atBill = result.balance_at_next_big_bill?.p50 ?? result.days.at(-1)!.p50;
    if (atBill >= buffer && result.shortfall_probability <= 0.1) best = { limit: cap, result };
    else break;
  }
  return best ?? { limit: 5, result: forecast({ ...input, gamblingWeeklyCap: 5 }) };
}

/** % change in gambling-flagged spend: last 28 days vs the 28 before. */
export function gamblingChangePct(txs: Transaction[], cs: Classification[], asOf: string): number | null {
  const ids = new Set(cs.filter((c) => c.confidence >= THRESHOLDS.ask).map((c) => c.transaction_id));
  const now = Date.parse(asOf) + 86_400_000;
  const sum = (from: number, to: number) => txs
    .filter((t) => ids.has(t.id) && t.amount < 0 && Date.parse(t.posted_at) >= from && Date.parse(t.posted_at) < to)
    .reduce((a, t) => a - t.amount, 0);
  const recent = sum(now - 28 * 86_400_000, now);
  const before = sum(now - 56 * 86_400_000, now - 28 * 86_400_000);
  if (before === 0) return null;
  return Math.round(((recent - before) / before) * 100);
}

export function flaggedList(txs: Transaction[], cs: Classification[], limit = 8) {
  const byId = new Map(txs.map((t) => [t.id, t]));
  return cs
    .filter((c) => c.confidence >= THRESHOLDS.ask)
    .map((c) => ({ c, t: byId.get(c.transaction_id)! }))
    .sort((a, b) => b.t.posted_at.localeCompare(a.t.posted_at))
    .slice(0, limit)
    .map(({ c, t }) => ({
      transaction_id: t.id, posted_at: t.posted_at, description: t.description, amount: t.amount,
      label: c.label, confidence: c.confidence, reasons: c.reasons, reason: c.reasons.slice(0, 2).join("; "),
    }));
}
