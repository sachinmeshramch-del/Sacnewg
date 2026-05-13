// ── Enhanced Exhaustion Engine ────────────────────────────────────────────────
// Detects when a move is running out of steam before the market reverses.
// Goes deeper than the basic exhaustion in momentumEngine.ts — scores 8 axes
// and requires 3+ signals to confirm exhaustion.
//
// Axes:
//   1. Shrinking candle bodies (last 3 bars shrinking in trend direction)
//   2. Long rejection wicks (last 2 bars have large opposing wicks)
//   3. ATR contraction (recent ATR < 70% of baseline ATR)
//   4. RSI flattening (RSI change < 2 over last 2 readings)
//   5. MACD histogram weakening (3+ consecutive bars shrinking in magnitude)
//   6. Consecutive weak candles (3+ of last 5 bars body < 30% range)
//   7. Failed continuation (last bar moved opposite to trend direction)
//   8. Price velocity collapse (price move last 3 bars < 25% of ATR)

export interface ExhaustionInput {
  open:              number[];
  high:              number[];
  low:               number[];
  close:             number[];
  atr:               number;
  rsi:               number;
  prevRsi:           number;
  macdHistogram:     number;
  prevMacdHistogram: number;
  ema20:             number;
  trendDirection:    "BULLISH" | "BEARISH" | "SIDEWAYS";
  signal:            "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
}

export interface ExhaustionResult {
  exhausted:         boolean;
  score:             number;   // 0–8, ≥ 3 = exhausted
  reasons:           string[];
  label:             string | null;
  confidencePenalty: number;   // 0 / -10 / -20 / -30
  blockSignal:       boolean;  // true when score ≥ 5 (strong exhaustion)
}

function bodyRatio(o: number, h: number, l: number, c: number): number {
  const range = h - l;
  if (range === 0) return 0;
  return Math.abs(c - o) / range;
}

function wickRatio(o: number, h: number, l: number, c: number, side: "upper" | "lower"): number {
  const range = h - l;
  if (range === 0) return 0;
  const wick = side === "upper" ? h - Math.max(o, c) : Math.min(o, c) - l;
  return wick / range;
}

export function runEnhancedExhaustion(input: ExhaustionInput): ExhaustionResult {
  const { open, high, low, close, atr, rsi, prevRsi, macdHistogram, prevMacdHistogram, trendDirection, signal } = input;
  const n = close.length;

  if (n < 5 || atr <= 0 || (signal !== "BUY" && signal !== "SELL")) {
    return { exhausted: false, score: 0, reasons: [], label: null, confidencePenalty: 0, blockSignal: false };
  }

  const reasons: string[] = [];
  let score = 0;

  const isBull = trendDirection === "BULLISH" || signal === "BUY";
  const isBear = trendDirection === "BEARISH" || signal === "SELL";

  // ── 1. Shrinking candle bodies in trend direction ─────────────────────────
  if (n >= 4) {
    const bodies = [
      Math.abs(close[n - 4] - open[n - 4]),
      Math.abs(close[n - 3] - open[n - 3]),
      Math.abs(close[n - 2] - open[n - 2]),
      Math.abs(close[n - 1] - open[n - 1]),
    ];
    const shrinking = bodies[0] > bodies[1] && bodies[1] > bodies[2] && bodies[2] > bodies[3];
    const trendCandles = (() => {
      let cnt = 0;
      for (let i = n - 4; i < n; i++) {
        if (isBull && close[i] > open[i]) cnt++;
        if (isBear && close[i] < open[i]) cnt++;
      }
      return cnt;
    })();
    if (shrinking && trendCandles >= 3) {
      score++;
      reasons.push("Candle bodies shrinking — momentum decelerating");
    }
  }

  // ── 2. Long rejection wicks (opposing direction) ──────────────────────────
  if (n >= 2) {
    let wickCount = 0;
    for (let i = n - 2; i < n; i++) {
      const oppWick = isBull
        ? wickRatio(open[i], high[i], low[i], close[i], "upper")
        : wickRatio(open[i], high[i], low[i], close[i], "lower");
      if (oppWick >= 0.40) wickCount++;
    }
    if (wickCount >= 2) {
      score++;
      reasons.push("Repeated rejection wicks — buyers/sellers being absorbed");
    } else if (wickCount === 1) {
      const oppWick = isBull
        ? wickRatio(open[n - 1], high[n - 1], low[n - 1], close[n - 1], "upper")
        : wickRatio(open[n - 1], high[n - 1], low[n - 1], close[n - 1], "lower");
      if (oppWick >= 0.55) {
        score++;
        reasons.push("Strong rejection wick on last bar — supply/demand absorbing");
      }
    }
  }

  // ── 3. ATR contraction (recent volatility collapsing) ─────────────────────
  if (n >= 8) {
    let recentAtr = 0;
    let baseAtr   = 0;
    for (let i = n - 3; i < n; i++)       recentAtr += high[i] - low[i];
    for (let i = n - 8; i < n - 3; i++)   baseAtr   += high[i] - low[i];
    recentAtr /= 3;
    baseAtr   /= 5;
    if (baseAtr > 0 && recentAtr < baseAtr * 0.65) {
      score++;
      reasons.push(`ATR contracting (recent ${recentAtr.toFixed(1)} vs base ${baseAtr.toFixed(1)}) — volatility collapsing`);
    }
  }

  // ── 4. RSI flattening ─────────────────────────────────────────────────────
  const rsiChange = Math.abs(rsi - prevRsi);
  if (rsiChange < 1.5) {
    score++;
    reasons.push(`RSI flattening (Δ${rsiChange.toFixed(1)}) — momentum stalling`);
  }

  // ── 5. MACD histogram weakening (3+ consecutive shrinking bars) ───────────
  const macdChange = Math.abs(macdHistogram) - Math.abs(prevMacdHistogram);
  const sameSign   = Math.sign(macdHistogram) === Math.sign(prevMacdHistogram) || prevMacdHistogram === 0;
  if (sameSign && macdChange < -0.02) {
    score++;
    reasons.push("MACD histogram shrinking — directional momentum fading");
  }

  // ── 6. Consecutive weak candles (body < 30% of range) ─────────────────────
  if (n >= 5) {
    let weakCount = 0;
    for (let i = n - 5; i < n; i++) {
      if (bodyRatio(open[i], high[i], low[i], close[i]) < 0.30) weakCount++;
    }
    if (weakCount >= 3) {
      score++;
      reasons.push(`${weakCount}/5 candles have small bodies — choppy, indecisive candles`);
    }
  }

  // ── 7. Failed continuation (last bar moved against trend) ─────────────────
  if (n >= 2) {
    const lastBull = close[n - 1] > open[n - 1];
    const lastBear = close[n - 1] < open[n - 1];
    const lastBody = Math.abs(close[n - 1] - open[n - 1]);
    if (isBull && lastBear && lastBody > atr * 0.4) {
      score++;
      reasons.push("Last candle reversed against bullish trend — failed continuation");
    }
    if (isBear && lastBull && lastBody > atr * 0.4) {
      score++;
      reasons.push("Last candle reversed against bearish trend — failed continuation");
    }
  }

  // ── 8. Price velocity collapse (3-bar move < 25% ATR) ────────────────────
  if (n >= 4) {
    const move3 = close[n - 1] - close[n - 4];
    const directionalMove = isBull ? move3 : -move3;
    if (directionalMove < atr * 0.25) {
      score++;
      reasons.push(`Price velocity collapsed (3-bar move: ${directionalMove.toFixed(2)} vs ATR ${atr.toFixed(2)}) — trend stalling`);
    }
  }

  const exhausted    = score >= 3;
  const blockSignal  = score >= 5;

  const label =
    score >= 5 ? "MOMENTUM EXHAUSTED" :
    score >= 3 ? "MOMENTUM WEAKENING" :
    null;

  const confidencePenalty =
    score >= 5 ? -30 :
    score >= 4 ? -20 :
    score >= 3 ? -12 :
    score >= 2 ? -6  : 0;

  return { exhausted, score, reasons, label, confidencePenalty, blockSignal };
}
