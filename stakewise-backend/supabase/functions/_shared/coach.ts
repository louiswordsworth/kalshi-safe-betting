// Layer 3 - EXPLAIN & COACH.
// The coach receives ONLY numbers already computed by the forecast and detection code.
// It turns them into plain, kind language and suggests one action. It must never invent
// a figure: the prompt forbids it and we check the output for numbers we didn't supply.

import type { ForecastResult } from "./types.ts";
import { chatJson } from "./llm.ts";

export interface CoachFacts {
  first_name: string;
  balance_now: number;
  next_big_bill: { description: string; date: string; amount: number } | null;
  balance_at_bill_typical: number | null;
  balance_at_bill_worst_likely: number | null;
  shortfall_chance_pct: number;
  gambling_weekly_pace: number;
  gambling_change_pct_vs_previous_month: number | null;
  flagged_transactions: { description: string; amount: number; reason: string }[];
  suggested_weekly_limit: number;
  with_limit_balance_at_bill_typical: number | null;
  with_limit_shortfall_chance_pct: number | null;
}

export interface CoachMessage {
  headline: string;
  body: string;
  action: { label: string; type: "set_weekly_limit" | "pause_48h" | "talk_to_someone" | "none"; value?: number };
  support_link: boolean;
  source: "llm" | "template";
}

export function buildFacts(
  firstName: string,
  base: ForecastResult,
  withLimit: ForecastResult | null,
  suggestedLimit: number,
  flagged: CoachFacts["flagged_transactions"],
  changePct: number | null,
): CoachFacts {
  const r = (x: number | undefined | null) => (x === undefined || x === null ? null : Math.round(x));
  return {
    first_name: firstName,
    balance_now: Math.round(base.starting_balance),
    next_big_bill: base.next_big_bill
      ? { description: base.next_big_bill.description, date: base.next_big_bill.date, amount: Math.round(Math.abs(base.next_big_bill.amount)) }
      : null,
    balance_at_bill_typical: r(base.balance_at_next_big_bill?.p50),
    balance_at_bill_worst_likely: r(base.balance_at_next_big_bill?.p10),
    shortfall_chance_pct: Math.round(base.shortfall_probability * 100),
    gambling_weekly_pace: Math.round(base.gambling_weekly_pace),
    gambling_change_pct_vs_previous_month: changePct,
    flagged_transactions: flagged.slice(0, 5),
    suggested_weekly_limit: suggestedLimit,
    with_limit_balance_at_bill_typical: r(withLimit?.balance_at_next_big_bill?.p50),
    with_limit_shortfall_chance_pct: withLimit ? Math.round(withLimit.shortfall_probability * 100) : null,
  };
}

const SYSTEM = `You are Stakewise, a kind, plain-speaking money coach inside a UK banking app.
You help people who bet, including on prediction markets, keep it within their means.
Rules:
- Use ONLY the numbers in the FACTS JSON. Never calculate, estimate or invent any other number.
- Never say "bet", "safe bet" or tell the user to place or not place a bet. Talk about money and bills.
- No judgement, no shame, no lectures. Write like a supportive friend.
- Plain English at roughly a reading age of 11 when plain_language is true. Short sentences.
- Suggest exactly ONE action from: set_weekly_limit (use suggested_weekly_limit), pause_48h, talk_to_someone, none.
- If shortfall_chance_pct >= 70, set support_link to true.
- Reply in the requested language.
Return JSON: {"headline": string (max 12 words), "body": string (max 60 words),
"action": {"label": string, "type": string, "value": number|null}, "support_link": boolean}`;

/** Every number in the output must appear in the facts (or be the action value). */
export function numbersAreGrounded(text: string, facts: CoachFacts): boolean {
  // \d only matches 0-9, so digits from other scripts (e.g. Hindi, Arabic) would slip past the check.
  // Treat them as ungrounded; the caller falls back to the template.
  if (/(?!\d)\p{Nd}/u.test(text)) return false;
  const allowed = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number") { allowed.add(String(Math.abs(v))); allowed.add(String(Math.abs(Math.round(v)))); }
    else if (typeof v === "string") (v.match(/\d+/g) ?? []).forEach((n) => allowed.add(String(Number(n))));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  const found = (text.replace(/,/g, "").match(/\d+(\.\d+)?/g) ?? []).map((n) => String(Number(n)));
  return found.every((n) => allowed.has(n) || allowed.has(String(Math.round(Number(n)))));
}

export function templateMessage(f: CoachFacts): CoachMessage {
  const bill = f.next_big_bill;
  if (bill && f.balance_at_bill_typical !== null && f.balance_at_bill_typical < 0) {
    return {
      headline: `Heads up: ${bill.description} could be tight`,
      body: `At your current pace you could be about £${Math.abs(f.balance_at_bill_typical)} short when ${bill.description} (£${bill.amount}) is due on ${bill.date}. ` +
        (f.with_limit_balance_at_bill_typical !== null
          ? `With a £${f.suggested_weekly_limit} weekly limit, you'd likely have about £${f.with_limit_balance_at_bill_typical} left instead.`
          : ""),
      action: { label: `Set a £${f.suggested_weekly_limit} weekly limit`, type: "set_weekly_limit", value: f.suggested_weekly_limit },
      support_link: f.shortfall_chance_pct >= 70,
      source: "template",
    };
  }
  return {
    headline: "You're on track this month",
    body: bill ? `You look on course to cover ${bill.description} on ${bill.date}. Nice one.` : "No big bills coming up that look at risk.",
    action: { label: "No action needed", type: "none" },
    support_link: false,
    source: "template",
  };
}

export async function coach(facts: CoachFacts, opts: { language?: string; plainLanguage?: boolean } = {}): Promise<CoachMessage> {
  // Data minimisation: the model never sees the user's name
  const { first_name: _name, ...modelFacts } = facts;
  const user = `LANGUAGE: ${opts.language ?? "English"}\nplain_language: ${opts.plainLanguage ?? true}\nFACTS:\n${JSON.stringify(modelFacts)}`;
  const out = await chatJson<Omit<CoachMessage, "source">>(SYSTEM, user);
  if (!out || !out.headline || !out.body) return templateMessage(facts);
  if (!numbersAreGrounded(`${out.headline} ${out.body} ${out.action?.label ?? ""}`, facts)) {
    console.warn("Coach output contained ungrounded numbers; using template");
    return templateMessage(facts);
  }
  // The action is data the UI will act on, so it is checked too (a made-up limit value must never reach the button)
  const TYPES = ["set_weekly_limit", "pause_48h", "talk_to_someone", "none"];
  const a = out.action;
  if (!a || !TYPES.includes(a.type) || (a.type === "set_weekly_limit" && a.value !== facts.suggested_weekly_limit)) {
    console.warn("Coach output had an invalid action; using template");
    return templateMessage(facts);
  }
  return { ...out, support_link: out.support_link === true || facts.shortfall_chance_pct >= 70, source: "llm" };
}
