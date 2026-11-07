// Layer 1 - DETECT.
// Rules give a first pass (known operators, merchant code 7995, funding routes that
// bypass bank gambling blocks). Behaviour signals then raise or lower confidence.
// Ambiguous results are refined by the LLM (see classify-transactions) and finally by
// the user's own answers, which always win.

import type { Category, Classification, Label, Transaction } from "./types.ts";

const GAMBLING_OPERATORS = [
  "bet365", "sky bet", "skybet", "paddy power", "paddypower", "betfair", "william hill",
  "ladbrokes", "coral", "betway", "betfred", "unibet", "888", "boylesports", "betvictor",
  "grosvenor", "pokerstars", "national lottery", "tombola",
];
const PREDICTION_MARKETS = ["kalshi", "polymarket", "predictit", "betinasia", "madmarket"];
const CRYPTO_ONRAMPS = [
  "coinbase", "crypto.com", "binance", "kraken", "moonpay", "bitstamp", "gemini",
  "uphold", "ramp network", "transak", "bitpanda",
];
const EWALLETS = ["skrill", "neteller", "paysafecard", "ecopayz", "muchbetter", "astropay"];
const INTL_TRANSFER = ["wise", "transferwise", "remitly", "western union", "moneygram", "intl transfer"];

export const THRESHOLDS = { gambling: 0.75, ask: 0.4 };

/** Lower-case, strip card-terminal noise, so "COINBASE UK*TOPUP 1234" -> "coinbase uk topup". */
export function merchantKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[*#]/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

function has(desc: string, list: string[]): boolean {
  return list.some((k) => desc.includes(k));
}

function baseRule(t: Transaction): { category: Category; confidence: number; reason: string } {
  const d = t.description.toLowerCase();
  if (t.mcc === "7995") return { category: "gambling_operator", confidence: 0.99, reason: "Merchant code 7995 (gambling)" };
  if (has(d, PREDICTION_MARKETS)) return { category: "prediction_market", confidence: 0.97, reason: "Known prediction-market platform" };
  if (has(d, GAMBLING_OPERATORS)) return { category: "gambling_operator", confidence: 0.97, reason: "Known gambling operator" };
  if (has(d, CRYPTO_ONRAMPS)) return { category: "crypto_onramp", confidence: 0.4, reason: "Crypto top-up: a common way to fund prediction markets" };
  if (has(d, EWALLETS)) return { category: "ewallet", confidence: 0.45, reason: "E-wallet often used to get round bank gambling blocks" };
  if (has(d, INTL_TRANSFER)) return { category: "international_transfer", confidence: 0.36, reason: "International transfer" };
  return { category: "other", confidence: 0.02, reason: "No gambling signal" };
}

export function labelFor(confidence: number): Label {
  if (confidence >= THRESHOLDS.gambling) return "gambling";
  if (confidence >= THRESHOLDS.ask) return "ask_user";
  return "not_gambling";
}

/** Detect pay days (credits) so we can spot "money out straight after payday". */
function paydays(txs: Transaction[]): string[] {
  return txs.filter((t) => t.amount > 50).map((t) => t.posted_at.slice(0, 10));
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

/**
 * Classify every transaction with rules + behaviour signals.
 * `feedback` maps merchantKey -> true/false from the user's own answers.
 */
export function classifyWithRules(
  txs: Transaction[],
  feedback: Record<string, boolean> = {},
): Classification[] {
  const sorted = [...txs].sort((a, b) => a.posted_at.localeCompare(b.posted_at));
  const pays = paydays(sorted);
  const out: Classification[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const key = merchantKey(t.description);

    if (t.amount >= 0) {
      out.push({ transaction_id: t.id, label: "not_gambling", category: "other", confidence: 0, reasons: ["Money in"], source: "rules" });
      continue;
    }
    if (key in feedback) {
      const yes = feedback[key];
      out.push({
        transaction_id: t.id, label: yes ? "gambling" : "not_gambling",
        category: yes ? "prediction_market" : "other", confidence: yes ? 1 : 0,
        reasons: [yes ? "You told us this is betting" : "You told us this isn't betting"], source: "user",
      });
      continue;
    }

    const base = baseRule(t);
    let conf = base.confidence;
    const reasons = [base.reason];

    // Behaviour signals only matter for the ambiguous funding routes.
    if (base.category !== "other" && conf < 0.95) {
      const hour = new Date(t.posted_at).getUTCHours();
      if (hour >= 0 && hour < 5) { conf += 0.1; reasons.push("Made between midnight and 5am"); }

      const date = t.posted_at.slice(0, 10);
      if (pays.some((p) => { const d = daysBetween(p, date); return d >= 0 && d <= 2; })) {
        conf += 0.08; reasons.push("Within 2 days of payday");
      }

      const sameWeek = sorted.filter((o) =>
        o.amount < 0 && merchantKey(o.description) === key &&
        Math.abs(daysBetween(o.posted_at, t.posted_at)) <= 7);
      if (sameWeek.length >= 3) { conf += 0.15; reasons.push(`${sameWeek.length} top-ups to this merchant within a week`); }

      const prev = sorted.slice(0, i).reverse().find((o) => o.amount < 0 && merchantKey(o.description) === key);
      if (prev && Math.abs(t.amount) >= Math.abs(prev.amount) * 1.4) {
        conf += 0.1; reasons.push(`Amount up ${Math.round((Math.abs(t.amount) / Math.abs(prev.amount) - 1) * 100)}% on the last one`);
      }

      if (Math.abs(t.amount) % 10 === 0) { conf += 0.04; reasons.push("Round-number amount"); }
      conf = Math.min(conf, 0.95);
    }
    conf = Math.round(conf * 100) / 100; // label from the same value we store (avoids 0.39999999999999997)

    out.push({
      transaction_id: t.id, label: labelFor(conf), category: base.category,
      confidence: conf, reasons, source: "rules",
    });
  }
  return out;
}

/** Merge an LLM opinion into a rules result: average, but never override the user. */
export function mergeLlm(rule: Classification, llmConfidence: number, llmReason: string): Classification {
  if (rule.source === "user") return rule;
  const conf = Math.round(((rule.confidence + llmConfidence) / 2) * 100) / 100;
  return { ...rule, confidence: conf, label: labelFor(conf), reasons: [...rule.reasons, `AI: ${llmReason}`], source: "llm" };
}
