// Layer 2 - FORECAST ("financial time travel").
// 1. Find recurring income (handles irregular, weekly shift pay) and recurring bills.
// 2. Everything else is day-to-day spending; gambling-flagged spend is tracked separately.
// 3. Monte Carlo: replay randomly sampled past days hundreds of times to get a range
//    (p10 / p50 / p90) instead of one over-confident line.
// All numbers are computed here, in code. The LLM never invents a figure.

import type { Classification, ForecastResult, ScheduledEvent, Transaction } from "./types.ts";
import { merchantKey, THRESHOLDS } from "./detect.ts";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (s: string) => Date.parse(s.slice(0, 10));

/** Small seeded PRNG so a demo gives the same answer every run. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

interface Recurring {
  key: string;
  description: string;
  kind: "income" | "bill";
  cadenceDays: number;
  lastDate: string;
  dayOfMonth: number | null; // monthly bills keep their day of month
  amounts: number[]; // history, signed
}

/** Find recurring income and bills. */
export function findRecurring(txs: Transaction[], gamblingIds: Set<string>): Recurring[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (gamblingIds.has(t.id)) continue;
    const key = (t.amount > 0 ? "in:" : "out:") + merchantKey(t.description);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const out: Recurring[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.posted_at.localeCompare(b.posted_at));
    const gaps = list.slice(1).map((t, i) => (dayMs(t.posted_at) - dayMs(list[i].posted_at)) / DAY);
    const gap = median(gaps);
    const amts = list.map((t) => t.amount);
    const isIncome = key.startsWith("in:");

    if (isIncome) {
      if (Math.abs(amts[0]) < 50 || gap < 5 || gap > 35) continue;
    } else {
      const m = Math.abs(median(amts));
      const stable = amts.every((a) => Math.abs(Math.abs(a) - m) <= m * 0.2);
      const monthly = gap >= 25 && gap <= 35;
      const weekly = gap >= 6 && gap <= 8;
      if (!stable || !(monthly || weekly)) continue;
    }

    const last = list[list.length - 1];
    const monthlyBill = !isIncome && gap >= 25;
    out.push({
      key, description: last.description, kind: isIncome ? "income" : "bill",
      cadenceDays: Math.round(gap), lastDate: last.posted_at.slice(0, 10),
      dayOfMonth: monthlyBill ? new Date(last.posted_at).getUTCDate() : null,
      amounts: amts.slice(-6),
    });
  }
  return out;
}

/** Dates a recurring item will next hit within (from, to]. */
function projectDates(r: Recurring, fromMs: number, toMs: number): string[] {
  const dates: string[] = [];
  if (r.dayOfMonth !== null) {
    const d = new Date(fromMs);
    for (let m = 0; m < 3; m++) {
      const y = d.getUTCFullYear(), mo = d.getUTCMonth() + m;
      const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const ms = Date.UTC(y, mo, Math.min(r.dayOfMonth, lastDay));
      if (ms > fromMs && ms <= toMs) dates.push(iso(ms));
    }
  } else {
    let ms = dayMs(r.lastDate) + r.cadenceDays * DAY;
    while (ms <= fromMs) ms += r.cadenceDays * DAY;
    for (; ms <= toMs; ms += r.cadenceDays * DAY) dates.push(iso(ms));
  }
  return dates;
}

/** Daily totals (positive numbers = spent) for the last `days` days, including zero days. */
function dailyTotals(txs: Transaction[], asOfMs: number, days: number): number[] {
  const totals = new Array(days).fill(0);
  for (const t of txs) {
    const ago = Math.floor((asOfMs - dayMs(t.posted_at)) / DAY);
    if (ago >= 0 && ago < days) totals[ago] += -t.amount;
  }
  return totals;
}

export interface ForecastInput {
  transactions: Transaction[];
  classifications: Classification[];
  startingBalance: number;
  asOf: string; // YYYY-MM-DD, "today"
  horizonDays?: number;
  gamblingWeeklyCap?: number | null; // scenario: what if the user accepts a weekly limit?
  extraOutflowToday?: number; // scenario: what if they place this stake now?
  runs?: number;
  seed?: number;
}

export function forecast(input: ForecastInput): ForecastResult {
  const {
    transactions, classifications, startingBalance, asOf,
    horizonDays = 35, gamblingWeeklyCap = null, extraOutflowToday = 0, runs = 500, seed = 42,
  } = input;
  const asOfMs = dayMs(asOf);
  const toMs = asOfMs + horizonDays * DAY;

  const gamblingIds = new Set(
    classifications.filter((c) => c.confidence >= THRESHOLDS.ask).map((c) => c.transaction_id),
  );
  const recurring = findRecurring(transactions, gamblingIds);
  const recurringKeys = new Set(recurring.map((r) => r.key));

  // Scheduled events in the horizon
  const schedule = new Map<string, { r: Recurring; date: string }[]>();
  const keyEvents: ScheduledEvent[] = [];
  for (const r of recurring) {
    for (const date of projectDates(r, asOfMs, toMs)) {
      if (!schedule.has(date)) schedule.set(date, []);
      schedule.get(date)!.push({ r, date });
      keyEvents.push({ date, amount: Math.round(median(r.amounts) * 100) / 100, description: r.description, kind: r.kind });
    }
  }
  keyEvents.sort((a, b) => a.date.localeCompare(b.date));

  // Day-to-day spending (not recurring, not gambling) and gambling, sampled separately
  const isRecurringTx = (t: Transaction) =>
    recurringKeys.has((t.amount > 0 ? "in:" : "out:") + merchantKey(t.description));
  const everyday = transactions.filter((t) => t.amount < 0 && !gamblingIds.has(t.id) && !isRecurringTx(t));
  const gambling = transactions.filter((t) => t.amount < 0 && gamblingIds.has(t.id));
  const everydayDays = dailyTotals(everyday, asOfMs, 56);
  const gamblingDays = dailyTotals(gambling, asOfMs, 28);
  const gamblingWeeklyPace = Math.round((gamblingDays.reduce((a, b) => a + b, 0) / 4) * 100) / 100;

  // The shortfall question users care about: "will I be short before my next big bill?"
  const bills0 = keyEvents.filter((e) => e.kind === "bill");
  const bigBill = bills0.length ? bills0.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a)) : null;
  const checkUntil = bigBill ? Math.round((dayMs(bigBill.date) - asOfMs) / DAY) : horizonDays;

  // Monte Carlo
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const balances: number[][] = Array.from({ length: horizonDays }, () => []);
  let shortfallRuns = 0;

  for (let run = 0; run < runs; run++) {
    let bal = startingBalance - extraOutflowToday;
    let minBal = bal;
    let weekSpent = 0;
    for (let d = 1; d <= horizonDays; d++) {
      const date = iso(asOfMs + d * DAY);
      if ((d - 1) % 7 === 0) weekSpent = 0;
      for (const { r } of schedule.get(date) ?? []) {
        bal += r.kind === "income" ? pick(r.amounts) : median(r.amounts); // irregular pay is sampled
      }
      bal -= pick(everydayDays);
      let g = pick(gamblingDays);
      if (gamblingWeeklyCap !== null) g = Math.max(0, Math.min(g, gamblingWeeklyCap - weekSpent));
      weekSpent += g;
      bal -= g;
      balances[d - 1].push(bal);
      if (d <= checkUntil) minBal = Math.min(minBal, bal);
    }
    if (minBal < 0) shortfallRuns++;
  }

  const days = balances.map((vals, i) => {
    const s = [...vals].sort((a, b) => a - b);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return { date: iso(asOfMs + (i + 1) * DAY), p10: r2(percentile(s, 0.1)), p50: r2(percentile(s, 0.5)), p90: r2(percentile(s, 0.9)) };
  });

  const nextBig = bigBill;
  const atBill = nextBig ? days.find((d) => d.date === nextBig.date) ?? null : null;

  return {
    as_of: asOf,
    horizon_days: horizonDays,
    starting_balance: startingBalance,
    days,
    // Capped at 99%: a forecast should never claim certainty
    shortfall_probability: Math.min(0.99, Math.round((shortfallRuns / runs) * 100) / 100),
    first_likely_shortfall: days.find((d) => d.p50 < 0)?.date ?? null,
    key_events: keyEvents,
    next_big_bill: nextBig,
    balance_at_next_big_bill: atBill ? { p10: atBill.p10, p50: atBill.p50, p90: atBill.p90 } : null,
    gambling_weekly_pace: gamblingWeeklyPace,
    scenario: { gambling_weekly_cap: gamblingWeeklyCap, extra_outflow_today: extraOutflowToday },
  };
}
