// Run: deno test -A tests/
import { assert, assertAlmostEquals, assertEquals } from "./assert.ts";
import fx from "./fixtures.json" with { type: "json" };
import { classifyWithRules, merchantKey } from "../supabase/functions/_shared/detect.ts";
import { forecast } from "../supabase/functions/_shared/forecast.ts";
import { affordability, deMargin, hiddenCost, overall } from "../supabase/functions/_shared/stake.ts";
import { buildFacts, numbersAreGrounded, templateMessage } from "../supabase/functions/_shared/coach.ts";
import { suggestWeeklyLimit } from "../supabase/functions/_shared/insights.ts";
import type { Transaction } from "../supabase/functions/_shared/types.ts";

const txs = fx.transactions as Transaction[];
const cs = classifyWithRules(txs);
const byDesc = (d: string) => cs.filter((c) => txs.find((t) => t.id === c.transaction_id)!.description === d);
const input = { transactions: txs, classifications: cs, startingBalance: fx.balance, asOf: fx.today };

Deno.test("merchantKey strips card noise", () => {
  assertEquals(merchantKey("COINBASE UK*TOPUP 1234"), "coinbase uk");
  assertEquals(merchantKey("SKRILL*PAY 8812"), "skrill pay");
});

Deno.test("detect: merchant code 7995 and known operators are gambling", () => {
  assert(byDesc("SKY BET").every((c) => c.label === "gambling"));
});

Deno.test("detect: ordinary spending is never flagged", () => {
  for (const d of ["TESCO STORES 2231", "OAKWOOD LETTINGS RENT", "SHIFTWORKS LTD PAYROLL"]) {
    assert(byDesc(d).every((c) => c.label === "not_gambling"), d);
  }
});

Deno.test("detect: crypto top-ups are caught even without code 7995, escalation raises confidence", () => {
  const coin = byDesc("COINBASE UK*TOPUP");
  assert(coin.every((c) => c.label !== "not_gambling"));
  const latest = coin.at(-1)!; // 00:13, £60, up on previous
  assertEquals(latest.label, "gambling");
  assert(latest.reasons.some((r) => r.includes("midnight")));
});

Deno.test("detect: the user's answer always wins", () => {
  const withFb = classifyWithRules(txs, { "wise intl": false, "coinbase uk": true });
  const wise = withFb.find((c) => txs.find((t) => t.id === c.transaction_id)!.description === "WISE INTL TRANSFER")!;
  assertEquals(wise.label, "not_gambling");
  assertEquals(wise.source, "user");
});

Deno.test("forecast: finds weekly pay and rent on the 28th", () => {
  const f = forecast(input);
  assert(f.key_events.some((e) => e.kind === "income" && e.description.includes("SHIFTWORKS")));
  assertEquals(f.next_big_bill?.date, "2026-11-28");
  assertEquals(f.next_big_bill?.amount, -520);
});

Deno.test("forecast: current pace leaves Priya short on rent day; a weekly limit fixes it", () => {
  const base = forecast(input);
  assert(base.balance_at_next_big_bill!.p50 < 0);
  assert(base.shortfall_probability > 0.7);
  const { limit, result } = suggestWeeklyLimit(input, base.gambling_weekly_pace);
  assert(limit >= 5 && limit < base.gambling_weekly_pace);
  assert(result.balance_at_next_big_bill!.p50 >= 50);
  assert(result.shortfall_probability <= 0.1);
});

Deno.test("forecast: bands are ordered and deterministic", () => {
  const a = forecast(input), b = forecast(input);
  assertEquals(a.days, b.days);
  assert(a.days.every((d) => d.p10 <= d.p50 && d.p50 <= d.p90));
});

Deno.test("stake: de-margin example 1.80 / 2.10 -> 53.8% / 46.2%", () => {
  const [a, b] = deMargin([1.8, 2.1]);
  assertAlmostEquals(a, 0.538, 0.001);
  assertAlmostEquals(b, 0.462, 0.001);
});

Deno.test("stake: 57c Kalshi price vs 53.8% fair is about 5 points above market", () => {
  const c = hiddenCost({ platform: "kalshi", price: 0.57, fairProbability: 0.538, stake: 40 });
  assertEquals(c.fee_per_contract, 0.02);
  assertEquals(c.verdict, "above_market");
  assertAlmostEquals(c.gap_points, 5.2, 0.11);
  assert(c.hidden_cost_gbp > 3 && c.hidden_cost_gbp < 4);
});

Deno.test("stake: a £40 stake is blocked when it pushes rent into the red; per-bet limit enforced", () => {
  const withStake = forecast({ ...input, extraOutflowToday: 40 });
  const without = forecast(input);
  const rules = affordability({
    stake: 40, limits: { weekly_gambling_limit: null, per_bet_max: 25, self_exclusion_until: null },
    transactions: txs, classifications: cs, now: new Date("2026-11-07T12:00:00Z"),
    forecastWithStake: withStake, forecastWithout: without,
  });
  assertEquals(overall(rules), "block");
  assert(rules.some((r) => r.rule === "per_bet_max" && r.status === "block"));
  assert(rules.some((r) => r.rule === "forecast" && r.status === "block"));
});

Deno.test("stake: self-exclusion blocks everything", () => {
  const f = forecast(input);
  const rules = affordability({
    stake: 1, limits: { weekly_gambling_limit: null, per_bet_max: null, self_exclusion_until: "2026-11-09T00:00:00Z" },
    transactions: txs, classifications: cs, now: new Date("2026-11-07T12:00:00Z"), forecastWithStake: f, forecastWithout: f,
  });
  assertEquals(overall(rules), "block");
});

Deno.test("coach: template uses only grounded numbers; invented numbers are caught", () => {
  const base = forecast(input);
  const { limit, result } = suggestWeeklyLimit(input, base.gambling_weekly_pace);
  const facts = buildFacts("Priya", base, result, limit, [], 406);
  const msg = templateMessage(facts);
  assert(numbersAreGrounded(`${msg.headline} ${msg.body} ${msg.action.label}`, facts), msg.body);
  assertEquals(msg.action.type, "set_weekly_limit");
  assertEquals(numbersAreGrounded("You'll be £9999 short", facts), false);
});
