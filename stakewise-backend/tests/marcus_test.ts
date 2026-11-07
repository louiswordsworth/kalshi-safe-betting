// Second demo persona: Marcus, salaried and comfortable. Run: deno test -A tests/
// Data comes from scripts/generate_seed_marcus.py. Priya (fixtures.json) is the contrast.
import { assert, assertEquals } from "./assert.ts";
import marcusFx from "./fixtures_marcus.json" with { type: "json" };
import priyaFx from "./fixtures.json" with { type: "json" };
import { classifyWithRules } from "../supabase/functions/_shared/detect.ts";
import { forecast } from "../supabase/functions/_shared/forecast.ts";
import { affordability, overall } from "../supabase/functions/_shared/stake.ts";
import { buildFacts, templateMessage } from "../supabase/functions/_shared/coach.ts";
import { gamblingChangePct, suggestWeeklyLimit } from "../supabase/functions/_shared/insights.ts";
import type { Transaction } from "../supabase/functions/_shared/types.ts";

type Fixture = { today: string; balance: number; transactions: unknown[] };

function setup(fx: Fixture) {
  const txs = fx.transactions as Transaction[];
  const cs = classifyWithRules(txs);
  const input = { transactions: txs, classifications: cs, startingBalance: fx.balance, asOf: fx.today };
  return { txs, cs, input };
}

function checkStake(fx: Fixture, stake: number) {
  const { txs, cs, input } = setup(fx);
  const without = forecast(input);
  const withStake = forecast({ ...input, extraOutflowToday: stake });
  const rules = affordability({
    stake, limits: { weekly_gambling_limit: null, per_bet_max: null, self_exclusion_until: null },
    transactions: txs, classifications: cs, now: new Date(fx.today + "T12:00:00Z"),
    forecastWithStake: withStake, forecastWithout: without,
  });
  return { rules, status: overall(rules), withStake, without };
}

Deno.test("marcus: Bet365 is flagged by the bank code, crypto top-ups are put to him, nothing else is flagged", () => {
  const { txs, cs } = setup(marcusFx);
  const desc = (id: string) => txs.find((t) => t.id === id)!.description;
  const flagged = cs.filter((c) => c.label !== "not_gambling");
  assert(flagged.length > 0);
  for (const c of flagged) {
    const d = desc(c.transaction_id);
    assert(d === "BET365" || d.startsWith("COINBASE"), `unexpected flag: ${d}`);
    assertEquals(c.label, d === "BET365" ? "gambling" : "ask_user");
  }
});

Deno.test("marcus: monthly salary and rent are found, and rent on 1 December is the next big bill", () => {
  const f = forecast(setup(marcusFx).input);
  assert(f.key_events.some((e) => e.kind === "income" && e.description.includes("BRIGHTHILL")));
  assertEquals(f.next_big_bill?.date, "2026-12-01");
  assertEquals(f.next_big_bill?.amount, -950);
});

Deno.test("marcus: comfortably covers rent at his current pace, even in the bad case", () => {
  const f = forecast(setup(marcusFx).input);
  assert(f.balance_at_next_big_bill!.p10 > 500, "worst likely balance should still be well above zero");
  assert(f.shortfall_probability <= 0.02);
  assert(f.days.every((d) => d.p10 > 0), "never dips below zero in the 5 weeks");
});

Deno.test("marcus: betting is steady, not escalating", () => {
  const { txs, cs } = setup(marcusFx);
  const change = gamblingChangePct(txs, cs, marcusFx.today)!;
  assert(change < 25, `spend change was ${change}%`);
});

Deno.test("contrast: the same £40 stake passes for Marcus and is blocked for Priya", () => {
  const marcus = checkStake(marcusFx, 40);
  assertEquals(marcus.status, "pass");
  assert(marcus.rules.some((r) => r.rule === "forecast" && r.status === "pass"));
  assert(marcus.withStake.balance_at_next_big_bill!.p50 > 1000);
  const priya = checkStake(priyaFx, 40);
  assertEquals(priya.status, "block");
});

Deno.test("marcus: the coach says he is on track and offers no action", () => {
  const { txs, cs, input } = setup(marcusFx);
  const base = forecast(input);
  const { limit, result } = suggestWeeklyLimit(input, base.gambling_weekly_pace);
  const msg = templateMessage(buildFacts("Marcus", base, result, limit, [], gamblingChangePct(txs, cs, marcusFx.today)));
  assertEquals(msg.headline, "You're on track this month");
  assertEquals(msg.action.type, "none");
  assertEquals(msg.support_link, false);
});
