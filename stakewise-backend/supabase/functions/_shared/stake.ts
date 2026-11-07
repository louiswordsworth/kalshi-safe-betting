// Point-of-decision check used by the overlay on a prediction-market page.
// Combines affordability rules, the forecast impact of this stake, and the
// hidden cost of the price versus the bookmaker consensus.

import type { Classification, ForecastResult, Limits, Transaction } from "./types.ts";
import { THRESHOLDS } from "./detect.ts";

// Taker fee coefficients: fee per contract ~= coeff * P * (1 - P).
// VERIFY against each platform's current fee schedule before relying on them.
export const FEE_COEFF: Record<string, number> = { kalshi: 0.07, polymarket: 0.0695, other: 0.07 };

export type RuleResult = { rule: string; status: "pass" | "warn" | "block"; reason: string };

/** Remove the bookmaker margin: decimal odds -> fair probabilities that sum to 1. */
export function deMargin(decimalOdds: number[]): number[] {
  const q = decimalOdds.map((o) => 1 / o);
  const sum = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / sum);
}

export function hiddenCost(params: {
  platform: string; price: number; fairProbability: number; stake: number;
}) {
  const { platform, price, fairProbability, stake } = params;
  const coeff = FEE_COEFF[platform] ?? FEE_COEFF.other;
  const fee = Math.ceil(coeff * price * (1 - price) * 100) / 100; // per $1 contract, rounded up to the cent
  const effective = price + fee;
  const gapPoints = Math.round((effective - fairProbability) * 1000) / 10;
  // Share of the stake that buys nothing versus a fair price (negative = cheaper than fair)
  const overpayShare = (effective - fairProbability) / effective;
  return {
    fee_per_contract: fee,
    effective_price: Math.round(effective * 1000) / 1000,
    fair_probability: Math.round(fairProbability * 1000) / 1000,
    gap_points: gapPoints,
    hidden_cost_gbp: Math.round(stake * overpayShare * 100) / 100,
    verdict: Math.abs(gapPoints) < 2 ? "in_line" : gapPoints > 0 ? "above_market" : "below_market",
  };
}

/** Affordability rules. Every rule says why. */
export function affordability(params: {
  stake: number;
  limits: Limits;
  transactions: Transaction[];
  classifications: Classification[];
  now: Date;
  forecastWithStake: ForecastResult;
  forecastWithout: ForecastResult;
}): RuleResult[] {
  const { stake, limits, transactions, classifications, now, forecastWithStake, forecastWithout } = params;
  const results: RuleResult[] = [];
  const gIds = new Set(classifications.filter((c) => c.confidence >= THRESHOLDS.ask).map((c) => c.transaction_id));
  const gambling = transactions.filter((t) => gIds.has(t.id) && t.amount < 0)
    .sort((a, b) => a.posted_at.localeCompare(b.posted_at));

  if (limits.self_exclusion_until && new Date(limits.self_exclusion_until) > now) {
    results.push({ rule: "self_exclusion", status: "block", reason: `You've paused betting until ${limits.self_exclusion_until.slice(0, 10)}.` });
  }

  if (limits.per_bet_max !== null) {
    results.push(stake > limits.per_bet_max
      ? { rule: "per_bet_max", status: "block", reason: `£${stake} is over your £${limits.per_bet_max} per-bet limit.` }
      : { rule: "per_bet_max", status: "pass", reason: `Within your £${limits.per_bet_max} per-bet limit.` });
  }

  if (limits.weekly_gambling_limit !== null) {
    const weekAgo = now.getTime() - 7 * 86_400_000;
    const spent = gambling.filter((t) => Date.parse(t.posted_at) >= weekAgo).reduce((a, t) => a - t.amount, 0);
    const after = Math.round((spent + stake) * 100) / 100;
    results.push(after > limits.weekly_gambling_limit
      ? { rule: "weekly_limit", status: "block", reason: `This would take you to £${after} this week, over your £${limits.weekly_gambling_limit} limit.` }
      : { rule: "weekly_limit", status: "pass", reason: `£${after} of your £${limits.weekly_gambling_limit} weekly limit.` });
  }

  // Forecast impact: does this stake push a big bill into the red?
  const bill = forecastWithStake.next_big_bill;
  const withB = forecastWithStake.balance_at_next_big_bill;
  const withoutB = forecastWithout.balance_at_next_big_bill;
  if (bill && withB && withoutB) {
    const day = bill.date;
    if (withB.p50 < 0) {
      results.push({ rule: "forecast", status: "block", reason: `Likely to leave you £${Math.abs(withB.p50).toFixed(0)} short when ${bill.description} is due on ${day}.` });
    } else if (withB.p10 < 0) {
      results.push({ rule: "forecast", status: "warn", reason: `There's a real chance (${Math.round(forecastWithStake.shortfall_probability * 100)}%) you'll be short before ${bill.description} on ${day}.` });
    } else {
      results.push({ rule: "forecast", status: "pass", reason: `You're on track to cover ${bill.description} on ${day}.` });
    }
  }

  // Loss chasing: rising stakes in a tight cluster
  const last = gambling.slice(-5).map((t) => -t.amount);
  if (last.length >= 3) {
    const avg = last.reduce((a, b) => a + b, 0) / last.length;
    const rising = last.slice(-3).every((v, i, a) => i === 0 || v >= a[i - 1]);
    if (stake > avg * 1.5 && rising) {
      results.push({ rule: "chasing", status: "warn", reason: `Your last few top-ups have been getting bigger, and this is ${Math.round((stake / avg - 1) * 100)}% above your recent average. That pattern often means chasing losses.` });
    }
  }

  // Timing and frequency
  const hour = now.getUTCHours();
  if (hour < 5) results.push({ rule: "late_night", status: "warn", reason: "It's late. Decisions made between midnight and 5am are riskier." });
  const recent = gambling.filter((t) => now.getTime() - Date.parse(t.posted_at) < 30 * 60_000).length;
  if (recent >= 3) results.push({ rule: "frequency", status: "warn", reason: `${recent} top-ups in the last 30 minutes.` });

  return results;
}

export function overall(results: RuleResult[]): "pass" | "warn" | "block" {
  if (results.some((r) => r.status === "block")) return "block";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
