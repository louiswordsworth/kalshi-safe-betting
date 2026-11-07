// POST /check-stake  - called by the overlay on a prediction-market page.
// {
//   "platform": "polymarket" | "kalshi" | "other",
//   "market_title": "Man City to beat Arsenal",
//   "price": 0.57,                 // price of the side being bought, 0..1
//   "stake_gbp": 40,
//   "bookmaker_odds": [1.80, 2.10] // optional decimal odds; FIRST = the outcome being bought
//   "fair_probability": 0.538      // optional alternative to bookmaker_odds
// }
import { admin, corsHeaders, json, loadContext, nowUtc, resolveUserId, today } from "../_shared/db.ts";
import { forecast } from "../_shared/forecast.ts";
import { affordability, deMargin, hiddenCost, overall } from "../_shared/stake.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const db = admin();
    const userId = await resolveUserId(req, db);
    if (!userId) return json({ error: "Not signed in" }, 401);
    const body = await req.json();
    const stake = Number(body.stake_gbp);
    const price = Number(body.price);
    if (!(stake > 0) || !(price > 0 && price < 1)) {
      return json({ error: "stake_gbp must be > 0 and price must be between 0 and 1" }, 400);
    }

    const ctx = await loadContext(db, userId);
    const input = { transactions: ctx.transactions, classifications: ctx.classifications, startingBalance: ctx.balance, asOf: today() };
    const without = forecast(input);
    const withStake = forecast({ ...input, extraOutflowToday: stake });

    const rules = affordability({
      stake, limits: ctx.limits, transactions: ctx.transactions, classifications: ctx.classifications,
      now: nowUtc(), forecastWithStake: withStake, forecastWithout: without,
    });

    let fair: number | null = null;
    if (Array.isArray(body.bookmaker_odds) && body.bookmaker_odds.length >= 2) fair = deMargin(body.bookmaker_odds.map(Number))[0];
    else if (typeof body.fair_probability === "number") fair = body.fair_probability;
    const cost = fair !== null
      ? hiddenCost({ platform: body.platform ?? "other", price, fairProbability: fair, stake })
      : null;

    const status = overall(rules);
    const bill = withStake.next_big_bill;
    const headline = status === "block"
      ? (rules.find((r) => r.status === "block")?.reason ?? "This one doesn't fit your budget.")
      : status === "warn"
      ? (rules.find((r) => r.status === "warn")?.reason ?? "Worth a second look.")
      : "This fits within your budget.";

    const result = {
      status, headline, rules,
      hidden_cost: cost
        ? { ...cost, message: cost.verdict === "above_market"
            ? `You're paying about ${cost.gap_points} points above what the betting market expects, roughly £${cost.hidden_cost_gbp} of this stake.`
            : cost.verdict === "below_market"
            ? `This price is about ${Math.abs(cost.gap_points)} points below the betting-market consensus.`
            : "This price is in line with the betting-market consensus." }
        : { message: "No benchmark available for this market." },
      forecast_impact: bill ? {
        bill: bill.description, date: bill.date,
        typical_balance_without: without.balance_at_next_big_bill?.p50 ?? null,
        typical_balance_with: withStake.balance_at_next_big_bill?.p50 ?? null,
        shortfall_chance_without: without.shortfall_probability,
        shortfall_chance_with: withStake.shortfall_probability,
      } : null,
      disclaimer: "Information only, not financial or betting advice.",
    };

    // Append-only audit log
    await db.from("checks").insert({
      user_id: userId, platform: body.platform ?? "other", market_title: body.market_title ?? null,
      inputs: body, result, rules_version: "2026-11-07.1",
    });

    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
