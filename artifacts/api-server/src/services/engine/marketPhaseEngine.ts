/**
 * Market Phase Engine
 * -------------------
 * Classifies the current market into one of four phases that directly
 * control whether entries are permitted and how much confidence is adjusted.
 *
 * Phases (priority order):
 *   EXHAUSTION  — 3+ large same-direction candles OR move already extended.
 *                 Block all new entries; "EXHAUSTED MOVE — WAIT FOR PULLBACK".
 *   CHOPPY      — No clean directional structure, low momentum, or range-bound.
 *                 Block all entries; "CHOPPY MARKET — HOLD".
 *   PULLBACK    — Price retracing toward EMA20 within an established trend.
 *                 Best entry condition; confirm with candle rejection.
 *   TRENDING    — Strong momentum continuation with clear direction.
 *                 Allow continuation entries.
 *
 * Inputs are all scalar values already computed by the time this engine
 * is called, so it adds zero latency and zero new data fetches.
 */

export type MarketPhase = "TRENDING" | "PULLBACK" | "CHOPPY" | "EXHAUSTION";

export interface MarketPhaseResult {
  phase:                MarketPhase;
  label:                string;
  confidenceAdjustment: number;
  allowTrade:           boolean;
  reason:               string;
}

interface MarketPhaseParams {
  currentPrice:    number;
  ema20:           number;
  atr:             number;
  chopScore:       number;
  trendStrength?:  "STRONG" | "WEAK" | "RANGE";
  momentumScore:   number;
  exhaustionScore: number;
  moveExtended:    boolean;
}

export function detectMarketPhase(p: MarketPhaseParams): MarketPhaseResult {
  const {
    currentPrice, ema20, atr,
    chopScore, trendStrength,
    momentumScore, exhaustionScore, moveExtended,
  } = p;

  const distFromEma  = Math.abs(currentPrice - ema20);
  const distATRs     = atr > 0 ? distFromEma / atr : 0;

  // ── 1. EXHAUSTION (highest priority — prevents momentum chasing) ───────────
  // Move extension filter already caught 3+ expansion candles; exhaustionEngine
  // caught shrinking momentum + wick expansion. Either is enough to block.
  if (exhaustionScore >= 4 || moveExtended) {
    return {
      phase:                "EXHAUSTION",
      label:                "Trend Exhausted",
      confidenceAdjustment: -20,
      allowTrade:           false,
      reason:               exhaustionScore >= 4
        ? `exhaustion score ${exhaustionScore}/8`
        : "move already extended from EMA20",
    };
  }

  // Price has run far from EMA20 (> 2.0 ATR) = chasing; don't enter
  if (distATRs > 2.0 && trendStrength !== "RANGE") {
    return {
      phase:                "EXHAUSTION",
      label:                "Overextended from EMA",
      confidenceAdjustment: -18,
      allowTrade:           false,
      reason:               `price ${distATRs.toFixed(1)}x ATR from EMA20 — overextended`,
    };
  }

  // ── 2. CHOPPY (block all trades) ─────────────────────────────────────────
  if (chopScore > 0.55 || trendStrength === "RANGE") {
    return {
      phase:                "CHOPPY",
      label:                "Choppy Market",
      confidenceAdjustment: -15,
      allowTrade:           false,
      reason:               trendStrength === "RANGE"
        ? "range-bound price action"
        : `chop score ${Math.round(chopScore * 100)}% — consolidating`,
    };
  }

  if (momentumScore < 30) {
    return {
      phase:                "CHOPPY",
      label:                "Low Momentum",
      confidenceAdjustment: -12,
      allowTrade:           false,
      reason:               `momentum score ${momentumScore}/100 — below minimum threshold`,
    };
  }

  // ── 3. PULLBACK (best entry condition) ───────────────────────────────────
  // Price has retraced to within 1.5 ATR of EMA20 — ideal zone for
  // continuation entries once a rejection candle confirms.
  if (distATRs <= 1.5 && trendStrength !== "RANGE") {
    return {
      phase:                "PULLBACK",
      label:                "Pullback to EMA20",
      confidenceAdjustment: +10,
      allowTrade:           true,
      reason:               `price ${distATRs.toFixed(1)}x ATR from EMA20 — ideal pullback zone`,
    };
  }

  // ── 4. TRENDING ──────────────────────────────────────────────────────────
  if (trendStrength === "STRONG" && momentumScore >= 55) {
    return {
      phase:                "TRENDING",
      label:                "Active Trend",
      confidenceAdjustment: +5,
      allowTrade:           true,
      reason:               `strong trend with momentum ${momentumScore}/100`,
    };
  }

  if (momentumScore >= 40) {
    return {
      phase:                "TRENDING",
      label:                "Trend Continuing",
      confidenceAdjustment: 0,
      allowTrade:           true,
      reason:               `moderate trend momentum ${momentumScore}/100`,
    };
  }

  // Default: mixed / unclear
  return {
    phase:                "CHOPPY",
    label:                "Mixed Conditions",
    confidenceAdjustment: -8,
    allowTrade:           false,
    reason:               "unclear market structure — no dominant direction",
  };
}
