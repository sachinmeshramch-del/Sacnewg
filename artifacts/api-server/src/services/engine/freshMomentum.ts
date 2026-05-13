// ── Fresh Momentum Detector ───────────────────────────────────────────────────
// Only allow entries when momentum is FRESH — not stale, not exhausted.
//
// FRESH SELL requires:
//   - Bearish body candle (close < open) with body ≥ 50% of range
//   - MACD histogram expanding bearish (more negative than prev)
//   - At least 1 of last 3 bars bearish
//   - No 5+ consecutive bearish bars (that's exhaustion, not fresh)
//
// FRESH BUY requires:
//   - Bullish body candle (close > open) with body ≥ 50% of range
//   - MACD histogram expanding bullish (more positive than prev)
//   - At least 1 of last 3 bars bullish
//   - No 5+ consecutive bullish bars (exhaustion)
//
// STALE = momentum direction exists but not currently accelerating.
// EXHAUSTED = 5+ consecutive same-direction candles without pullback.

export interface FreshMomentumInput {
  open:              number[];
  high:              number[];
  low:               number[];
  close:             number[];
  atr:               number;
  macdHistogram:     number;
  prevMacdHistogram: number;
  signal:            "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
}

export type FreshMomentumState = "FRESH" | "STALE" | "WAITING_PULLBACK" | "NEUTRAL";

export interface FreshMomentumResult {
  state:             FreshMomentumState;
  fresh:             boolean;
  stale:             boolean;
  reason:            string;
  label:             string | null;
  confidencePenalty: number;    // 0 = fresh, -8 = stale, -18 = waiting_pullback
}

function bodyRatio(o: number, h: number, l: number, c: number): number {
  const range = h - l;
  if (range === 0) return 0;
  return Math.abs(c - o) / range;
}

export function runFreshMomentumCheck(input: FreshMomentumInput): FreshMomentumResult {
  const { open, high, low, close, atr, macdHistogram, prevMacdHistogram, signal } = input;
  const n = close.length;

  if (n < 4 || signal !== "BUY" && signal !== "SELL") {
    return { state: "NEUTRAL", fresh: false, stale: false, reason: "No directional signal", label: null, confidencePenalty: 0 };
  }

  const isBuy  = signal === "BUY";
  const isSell = signal === "SELL";

  // ── Count consecutive same-direction bars (exhaustion check) ─────────────
  let consecutiveBull = 0;
  let consecutiveBear = 0;
  for (let i = n - 1; i >= Math.max(0, n - 7); i--) {
    if (close[i] > open[i]) { if (consecutiveBear === 0) consecutiveBull++; else break; }
    else if (close[i] < open[i]) { if (consecutiveBull === 0) consecutiveBear++; else break; }
    else break;
  }

  const consecutiveInDirection = isBuy ? consecutiveBull : consecutiveBear;
  if (consecutiveInDirection >= 5) {
    return {
      state: "WAITING_PULLBACK",
      fresh: false,
      stale: true,
      reason: `${consecutiveInDirection} consecutive ${isBuy ? "bullish" : "bearish"} bars — waiting for pullback before entry`,
      label: "WAITING FOR PULLBACK",
      confidencePenalty: -18,
    };
  }

  // ── Last candle quality ───────────────────────────────────────────────────
  const lastO = open[n - 1];
  const lastH = high[n - 1];
  const lastL = low[n - 1];
  const lastC = close[n - 1];
  const lastBullish = lastC > lastO;
  const lastBearish = lastC < lastO;
  const lastBodyRatio = bodyRatio(lastO, lastH, lastL, lastC);
  const lastBody = Math.abs(lastC - lastO);

  // ── MACD momentum expansion ───────────────────────────────────────────────
  const macdExpandingBull = macdHistogram > prevMacdHistogram && macdHistogram > 0;
  const macdExpandingBear = macdHistogram < prevMacdHistogram && macdHistogram < 0;

  // ── Candle direction matches signal ──────────────────────────────────────
  const candleAligned = isBuy ? lastBullish : lastBearish;
  const strongBody    = lastBodyRatio >= 0.45 && lastBody >= atr * 0.3;

  // ── Recent bars in signal direction (last 3) ──────────────────────────────
  let recentAligned = 0;
  for (let i = n - 3; i < n; i++) {
    if (isBuy  && close[i] > open[i]) recentAligned++;
    if (isSell && close[i] < open[i]) recentAligned++;
  }

  // ── Fresh conditions ──────────────────────────────────────────────────────
  const macdFresh = isBuy ? macdExpandingBull : macdExpandingBear;
  const freshConditions = [
    candleAligned,
    strongBody,
    macdFresh,
    recentAligned >= 1,
  ].filter(Boolean).length;

  if (freshConditions >= 3) {
    return {
      state: "FRESH",
      fresh: true,
      stale: false,
      reason: `Fresh ${isBuy ? "bullish" : "bearish"} momentum — candle aligned, MACD expanding, ${recentAligned}/3 recent bars aligned`,
      label: "FRESH MOMENTUM",
      confidencePenalty: 0,
    };
  }

  if (freshConditions === 2) {
    return {
      state: "FRESH",
      fresh: true,
      stale: false,
      reason: `Moderate fresh momentum (${freshConditions}/4 conditions met)`,
      label: null,
      confidencePenalty: 0,
    };
  }

  // ── Stale: signal direction but no current acceleration ──────────────────
  const noMacdExpansion = isBuy ? !macdExpandingBull : !macdExpandingBear;
  if (recentAligned >= 1 && noMacdExpansion) {
    return {
      state: "STALE",
      fresh: false,
      stale: true,
      reason: `${isBuy ? "Bullish" : "Bearish"} momentum stale — MACD not expanding, awaiting re-acceleration`,
      label: null,
      confidencePenalty: -8,
    };
  }

  // ── Weak / tiny candles ──────────────────────────────────────────────────
  if (!candleAligned || !strongBody) {
    return {
      state: "STALE",
      fresh: false,
      stale: true,
      reason: `Weak candle (body ratio: ${(lastBodyRatio * 100).toFixed(0)}%) — no conviction`,
      label: null,
      confidencePenalty: -10,
    };
  }

  return {
    state: "NEUTRAL",
    fresh: false,
    stale: false,
    reason: "Mixed momentum signals — insufficient fresh confirmation",
    label: null,
    confidencePenalty: -5,
  };
}
