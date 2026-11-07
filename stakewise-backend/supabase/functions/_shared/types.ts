// Shared types for the Stakewise backend.

export interface Transaction {
  id: string;
  user_id: string;
  posted_at: string; // ISO timestamp
  amount: number; // GBP. Negative = money out, positive = money in
  description: string;
  mcc?: string | null;
}

export type Label = "gambling" | "ask_user" | "not_gambling";

export type Category =
  | "gambling_operator"
  | "prediction_market"
  | "crypto_onramp"
  | "ewallet"
  | "international_transfer"
  | "other";

export interface Classification {
  transaction_id: string;
  label: Label;
  category: Category;
  confidence: number; // 0..1 that this is money going to gambling / speculation
  reasons: string[];
  source: "rules" | "llm" | "user";
}

export interface Limits {
  weekly_gambling_limit: number | null;
  per_bet_max: number | null;
  self_exclusion_until: string | null;
}

export interface ScheduledEvent {
  date: string; // YYYY-MM-DD
  amount: number; // signed
  description: string;
  kind: "income" | "bill";
}

export interface ForecastResult {
  as_of: string;
  horizon_days: number;
  starting_balance: number;
  days: { date: string; p10: number; p50: number; p90: number }[];
  shortfall_probability: number; // P(balance < 0 at any point up to the next big bill)
  first_likely_shortfall: string | null; // first date p50 < 0
  key_events: ScheduledEvent[];
  next_big_bill: ScheduledEvent | null;
  balance_at_next_big_bill: { p10: number; p50: number; p90: number } | null;
  gambling_weekly_pace: number;
  scenario: { gambling_weekly_cap: number | null; extra_outflow_today: number };
}
