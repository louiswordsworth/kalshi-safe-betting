# kalshi-safe-betting

An informational tool that checks whether a user can afford a proposed Kalshi trade, and whether the Kalshi price lines up with the de-margined consensus of sharp sports-betting markets.

## Motivation

When money gets tight, most people cut back, but the most vulnerable often bet more. With the explosive growth of prediction markets (like Polymarket and Kalshi), betting is increasingly disguised as "trading."

Traditional gambling guardrails are failing because they rely on outdated methods:

- GamStop: Only covers UK-licensed sites.

- Affordability Checks: Prediction markets often lack the licenses that require these checks.

- Bank Gambling Blocks: Easily bypassed. Crypto, e-wallets, and transfers skip standard gambling merchant codes (MCC 7995).

The result? High-risk gambling is slipping through the cracks. 35% of student gamblers borrow money to bet, and prediction markets have become sportsbooks in all but name, processing billions a month completely unhindered by standard blocks.

## The Solution: BetCheck

None of today's guardrails reach prediction markets. BetCheck changes the paradigm: Follow the money, not the merchant code.

BetCheck reads opt-in Open Banking data, sees the drop in finances coming, and puts the guardrail up while there's still track left. It steps in at the moment of decision—before a user taps "Buy"—with a friendly, realistic overlay showing exactly how a bet will impact their upcoming bills.

## How It Works (Three Essential AI Jobs)

- Detect: Spots the betting money that bank blocks miss. It identifies patterns like late-night crypto top-ups that keep growing or e-wallet payments straight after payday.

- Forecast: "Financial Time Travel." BetCheck runs 500 simulations of the next 35 days, built automatically around the user's real, irregular pay days and bills (rent, utilities).

- Coach: Steps in before the purchase. It explains the financial reality like a friend would ("This £40 would likely leave you £188 short when rent is due") and offers clear, immediate actions (e.g., Set a £30 weekly limit, Pause for 48 hours).

## Core Values & Responsible AI

- Harm Reduction, Not a Ban: We can't stop people from betting, but we can help them do it within their means. If risk remains high, we gently offer routes to GamCare and StepChange.

- Maths in Code, Not LLM Hallucinations: The AI explains the numbers, it never invents them. Any AI reply containing an unverified number is automatically replaced.

- Privacy First: Minimal data goes to the model—transaction descriptions and amounts only. No names, no account numbers.

- Built for Real Lives: Designed for irregular incomes (gig work, Universal Credit) with plain language, zero shame, and simple-reading modes.