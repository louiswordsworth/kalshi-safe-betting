# Stakewise backend

The backend for Stakewise, a money coach that puts guardrails in place before betting spending turns into a crisis.
It's built as Supabase edge functions (Deno + TypeScript), so it slots into a Lovable project.

Three AI layers, each one needed:

1. **Detect** (`classify-transactions`): rules and behaviour signals find money going to gambling,
   including the routes that get round bank gambling blocks (crypto top-ups, e-wallets, international transfers).
   An LLM refines the ambiguous ones, and the user's own answer always wins (`feedback`).
2. **Forecast** (`forecast`): finds pay days (including irregular weekly pay) and recurring bills, then
   runs 500 Monte Carlo simulations to give a likely range for the balance (p10 / p50 / p90), plus the
   chance of being short before the next big bill. This is the "financial time travel" part.
3. **Coach** (`coach`): an LLM explains the forecast in plain language and suggests one action.
   **All numbers are calculated in code.** The LLM only writes the words, and any reply that contains a
   number we didn't give it is thrown away and replaced with a template.

The overlay calls `check-stake` at the point of decision: it runs the affordability rules, checks what the
stake does to the forecast, and shows the hidden cost against the de-margined bookmaker odds.
Every check is written to an append-only audit log.

## The demo story (seeded data, "today" = 2026-11-07)

Priya is a student on weekly shift pay of about £150–£240, with rent of £520 due on the 28th and a current balance of £320.
Her betting has moved from small Sky Bet stakes to crypto and Skrill top-ups, often late at night.

| | Current pace (~£108/week) | With the suggested £30/week limit |
|---|---|---|
| Typical balance on rent day | **−£148** | **+£83** |
| Chance of going short before rent | **93%** | **9%** |

Betting spend over the last 28 days is up 406% on the 28 days before.
If she tries a £40 stake in the overlay, it's blocked, because it would leave her short on rent day.

## Files

```
supabase/
  migrations/20261107000000_stakewise_schema.sql   tables, row-level security, append-only audit trigger
  seed.sql                                          Priya's 90 days of mock bank data
  functions/
    _shared/detect.ts     layer 1 rules + behaviour signals
    _shared/forecast.ts   layer 2 recurring detection + Monte Carlo
    _shared/coach.ts      layer 3 LLM coach + number-grounding check + template fallback
    _shared/stake.ts      affordability rules, de-margin, fees, hidden cost
    _shared/insights.ts   suggested limit, spend change, flagged list
    _shared/llm.ts        OpenAI-compatible LLM client (works without a key: falls back)
    _shared/db.ts         Supabase client, auth/demo user, data loading
    classify-transactions/  forecast/  coach/  check-stake/  limits/  feedback/
scripts/generate_seed.py  regenerates seed.sql + tests/fixtures.json
tests/core_test.ts        17 unit tests for the core logic
```

## Setup

**Option A: Lovable with GitHub sync (recommended).** Connect your Lovable project to GitHub, copy the `supabase/`
folder into the repo and push. Lovable picks up the edge functions and the migration. Then ask Lovable:
*"Run the migration in supabase/migrations and the seed in supabase/seed.sql."*

**Option B: Supabase CLI**
```bash
supabase link --project-ref <your-ref>
supabase db push                       # schema
psql "$DATABASE_URL" -f supabase/seed.sql
supabase functions deploy classify-transactions forecast coach check-stake limits feedback
```

**Secrets** (in Lovable Cloud or the Supabase dashboard → Edge Functions → Secrets):

| Secret | Value |
|---|---|
| `DEMO_MODE` | `true`, so requests without a signed-in user use Priya |
| `DEMO_TODAY` | `2026-11-07`, which pins "today" (and "now", at noon UTC) so the story is the same every run. Optional `DEMO_NOW` pins the exact moment, e.g. `2026-11-07T00:30:00Z` to demo the late-night rule |
| `LLM_API_KEY` | your LLM key (or `LOVABLE_API_KEY` if using Lovable AI) |
| `LLM_API_URL` | an OpenAI-compatible chat-completions URL. The default is Lovable's AI gateway, so check Lovable's docs for the current URL |
| `LLM_MODEL` | e.g. `google/gemini-2.5-flash` or `gpt-4o-mini` |

Without an LLM key, everything still works: detection uses rules only and the coach uses templates.

## API (all POST unless stated; send the user's Supabase JWT as `Authorization: Bearer …`)

| Function | Body | Returns |
|---|---|---|
| `classify-transactions` | `{}` | `summary`, `flagged[]`, `questions[]` (ask the user "Was this for betting?"), `ai_used` |
| `feedback` | `{ transaction_id, is_gambling }` | Applies the user's answer to every transaction from that merchant |
| `forecast` | `{ weekly_cap?, extra_outflow?, horizon_days? }` | `baseline` and `scenario`, each with `days[] {date,p10,p50,p90}`, `shortfall_probability`, `next_big_bill`, `balance_at_next_big_bill` |
| `coach` | `{ language?, plain_language? }` | `message {headline, body, action, support_link}`, `evidence` (for "why am I seeing this?"), both forecasts, `suggested_weekly_limit` |
| `check-stake` | `{ platform, market_title, price, stake_gbp, bookmaker_odds?: [this, other…] }` | `status` pass/warn/block, `headline`, `rules[]`, `hidden_cost`, `forecast_impact` |
| `limits` (GET/POST) | `{ weekly_gambling_limit?, per_bet_max?, pause_hours? }` | Lowering or pausing applies now; raising waits 48 hours (`cooling_off`) |

Frontend call example:
```ts
const { data } = await supabase.functions.invoke("coach", { body: { plain_language: true } });
```

Chart tip: draw `days[].p10`–`p90` as a shaded band with `p50` as the line, baseline in one colour and
the `with_suggested_limit` scenario in another, plus a marker on `next_big_bill.date`.

## Tests

```bash
deno test -A tests/
```
The tests cover detection (code 7995, crypto routes, the user's answer winning), forecasting (pay and rent
detection, Priya short at her current pace and fixed by a limit, ordered and deterministic bands), stake
checks (the 1.80/2.10 → 53.8%/46.2% de-margin example, the hidden-cost maths, blocks), and the coach's
number-grounding check.

## Notes and limits

- Fee coefficients (`stake.ts`: Kalshi 0.07, Polymarket 0.0695) came from third-party guides, so check them against each platform's current fee schedule.
- Detection thresholds are starting points. Tune them with real (consented) data.
- Once money is in a crypto wallet we can't see individual bets, only the money leaving and its pattern.
- Information only, not financial or betting advice.
