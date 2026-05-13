// ── Momentum Quality Engine ───────────────────────────────────────────────────
// Produces a 0–100 momentum score from 6 independent axes:
//   1. Candle body strength   (0–20)
//   2. ATR expansion          (0–20)
//   3. EMA slope angle        (0–15)
//   4. MACD histogram accel   (0–15)
//   5. Momentum persistence   (0–15)
//   6. Breakout velocity      (0–15)
// Self-contained — no imports from goldService to avoid circular deps.

export interface MomentumInput {
  // OHLC arrays (full history)
  open:   number[];
  high:   number[];
  low:    number[];
  close:  number[];
  // Pre-computed indicators passed from goldService
  atr:         number;
  ema20:       number;
  ema50:       number;
  macdHistogram:     number;
  prevMacdHistogram: number;
  rsi:         number;
  isTrending:  boolean;
  isStrongTrend: boolean;
  trendDirection: "BULLISH" | "BEARISH" | "SIDEWAYS";
  // EMA arrays for slope calculation (last N values)
  ema20Series: number[];
}

export type MomentumLabel =
  | "STRONG_IMPULSE"   // 80+
  | "GOOD_TREND"       // 60–79
  | "WEAK"             // 40–59
  | "NO_TRADE";        // below 40

export interface MomentumAnalysis {
  score:          number;          // 0–100
  label:          MomentumLabel;
  // Sub-scores for debug panel
  bodyScore:      number;          // 0–20
  atrScore:       number;          // 0–20
  slopeScore:     number;          // 0–15
  macdScore:      number;          // 0–15
  persistScore:   number;          // 0–15
  velocityScore:  number;          // 0–15
  // Derived outputs
  tradeAllowed:   boolean;         // score >= 60
  stackingAllowed: boolean;        // score >= 75
  autoTradeOk:    boolean;         // score >= 75
  exhaustionDetected: boolean;
  exhaustionReasons:  string[];
  // Weighted confidence contribution 0–20 (for the weighted conf model)
  confidenceContrib: number;
  debugSummary:   string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Average true range over last N bars. */
function atrSlice(highs: number[], lows: number[], closes: number[], period = 5): number {
  const n = closes.length;
  if (n < 2) return 1;
  let sum = 0;
  const start = Math.max(1, n - period);
  for (let i = start; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    sum += Math.max(hl, hc, lc);
  }
  return sum / (n - start) || 1;
}

/** Candle body as fraction of full range (0..1). */
function bodyRatio(o: number, h: number, l: number, c: number): number {
  const range = h - l;
  if (range === 0) return 0;
  return Math.abs(c - o) / range;
}

// ── 1. Candle Body Strength (0–20) ───────────────────────────────────────────
// Average body/range ratio over the last 3 bars. Strong trend = fat bodies.
function scoreBodyStrength(
  open: number[], high: number[], low: number[], close: number[],
  atr: number,
): number {
  const n = close.length;
  if (n < 3) return 5;
  let ratioSum = 0;
  let bodySum  = 0;
  for (let i = n - 3; i < n; i++) {
    ratioSum += bodyRatio(open[i], high[i], low[i], close[i]);
    bodySum  += Math.abs(close[i] - open[i]);
  }
  const avgRatio = ratioSum / 3;   // 0..1 (higher = cleaner candles)
  const avgBody  = bodySum  / 3;
  // Body vs ATR: body ≥ 60% of ATR = strong
  const bodyVsAtr = Math.min(1, avgBody / (atr * 0.6));
  const raw = avgRatio * 0.5 + bodyVsAtr * 0.5;   // blend
  return Math.round(raw * 20);
}

// ── 2. ATR Expansion (0–20) ───────────────────────────────────────────────────
// Recent ATR (last 3 bars) vs longer-term ATR (last 10 bars).
// Expansion = volatility increasing = momentum building.
function scoreAtrExpansion(
  highs: number[], lows: number[], closes: number[], atr: number,
): number {
  const recentAtr = atrSlice(highs, lows, closes, 3);
  const longerAtr = atrSlice(highs, lows, closes, 10);
  if (longerAtr === 0) return 5;
  const ratio = recentAtr / longerAtr;  // >1 = expanding, <1 = contracting
  if (ratio >= 1.5) return 20;
  if (ratio >= 1.2) return 16;
  if (ratio >= 1.0) return 12;
  if (ratio >= 0.8) return 7;
  return 3;  // contracting ATR = no momentum
}

// ── 3. EMA Slope Angle (0–15) ─────────────────────────────────────────────────
// EMA20 slope over last 5 bars relative to ATR. Steeper = stronger trend.
function scoreEmaSlope(ema20Series: number[], atr: number): number {
  const n = ema20Series.length;
  if (n < 5) return 5;
  const rise = ema20Series[n - 1] - ema20Series[n - 5];
  const slope = Math.abs(rise) / 4 / (atr || 1);  // per-bar slope in ATR units
  if (slope >= 0.25) return 15;
  if (slope >= 0.15) return 12;
  if (slope >= 0.08) return 8;
  if (slope >= 0.03) return 4;
  return 1;
}

// ── 4. MACD Histogram Acceleration (0–15) ────────────────────────────────────
// Current histogram vs previous: growing = momentum accelerating.
function scoreMacdAccel(macdHist: number, prevMacdHist: number): number {
  const change = Math.abs(macdHist) - Math.abs(prevMacdHist);
  const sameSign = Math.sign(macdHist) === Math.sign(prevMacdHist) || prevMacdHist === 0;
  if (!sameSign) return 2;    // histogram crossed zero — momentum shifting
  if (change > 0.3)  return 15;
  if (change > 0.15) return 12;
  if (change > 0.05) return 9;
  if (change > 0)    return 6;
  return 2;  // decelerating
}

// ── 5. Momentum Persistence (0–15) ───────────────────────────────────────────
// How many of the last 5 candles are in the same direction?
function scorePersistence(
  open: number[], close: number[], trendDir: "BULLISH" | "BEARISH" | "SIDEWAYS",
): number {
  const n = close.length;
  if (n < 5) return 5;
  let count = 0;
  for (let i = n - 5; i < n; i++) {
    if (trendDir === "BULLISH" && close[i] > open[i]) count++;
    if (trendDir === "BEARISH" && close[i] < open[i]) count++;
  }
  if (count >= 5) return 15;
  if (count >= 4) return 12;
  if (count >= 3) return 9;
  if (count >= 2) return 4;
  return 1;
}

// ── 6. Breakout Velocity (0–15) ───────────────────────────────────────────────
// How far has price moved in the trend direction over the last 3 bars, relative to ATR?
function scoreVelocity(
  close: number[], atr: number, trendDir: "BULLISH" | "BEARISH" | "SIDEWAYS",
): number {
  const n = close.length;
  if (n < 4 || trendDir === "SIDEWAYS") return 4;
  const move = close[n - 1] - close[n - 4];
  const directionalMove = trendDir === "BULLISH" ? move : -move;
  const ratio = directionalMove / atr;  // in ATR units
  if (ratio >= 1.5) return 15;
  if (ratio >= 1.0) return 12;
  if (ratio >= 0.5) return 8;
  if (ratio >= 0.2) return 4;
  return 1;
}

// ── Exhaustion Detection ──────────────────────────────────────────────────────
function detectExhaustion(
  open:  number[], high: number[], low: number[], close: number[],
  atr:   number,
  ema20: number,
  rsi:   number,
): { exhausted: boolean; reasons: string[] } {
  const n = close.length;
  const reasons: string[] = [];

  if (n < 5) return { exhausted: false, reasons: [] };

  // 1. RSI overextension
  if (rsi >= 78) reasons.push("RSI overextended bullish (" + rsi.toFixed(0) + ")");
  if (rsi <= 22) reasons.push("RSI overextended bearish (" + rsi.toFixed(0) + ")");

  // 2. Large distance from EMA20 (parabolic extension)
  const distFromEma = Math.abs(close[n - 1] - ema20);
  if (distFromEma > atr * 2.5) reasons.push("Price extended " + (distFromEma / atr).toFixed(1) + "× ATR from EMA20");

  // 3. Repeated same-direction candles (≥5 consecutive)
  let runBull = 0, runBear = 0;
  for (let i = n - 5; i < n; i++) {
    if (close[i] > open[i]) runBull++; else runBear++;
  }
  if (runBull === 5) reasons.push("5 consecutive bullish candles — exhaustion risk");
  if (runBear === 5) reasons.push("5 consecutive bearish candles — exhaustion risk");

  // 4. ATR spike (last bar > 2× ATR = climax candle)
  const lastBar = Math.abs(close[n - 1] - open[n - 1]);
  if (lastBar > atr * 2.2) reasons.push("Climax candle (" + (lastBar / atr).toFixed(1) + "× ATR body)");

  // 5. Wick exhaustion: last candle body < 25% of range = rejection candle
  const lastRange = high[n - 1] - low[n - 1];
  const lastBody  = Math.abs(close[n - 1] - open[n - 1]);
  if (lastRange > 0 && lastBody / lastRange < 0.25 && lastRange > atr * 0.8) {
    reasons.push("Rejection candle — large wick, small body");
  }

  return { exhausted: reasons.length >= 2, reasons };
}

// ── Main Export ───────────────────────────────────────────────────────────────
export function runMomentumAnalysis(input: MomentumInput): MomentumAnalysis {
  const {
    open, high, low, close, atr, ema20, macdHistogram, prevMacdHistogram,
    rsi, trendDirection, ema20Series,
  } = input;

  const bodyScore    = scoreBodyStrength(open, high, low, close, atr);
  const atrScore     = scoreAtrExpansion(high, low, close, atr);
  const slopeScore   = scoreEmaSlope(ema20Series, atr);
  const macdScore    = scoreMacdAccel(macdHistogram, prevMacdHistogram);
  const persistScore = scorePersistence(open, close, trendDirection);
  const velocityScore = scoreVelocity(close, atr, trendDirection);

  const score = Math.min(100, bodyScore + atrScore + slopeScore + macdScore + persistScore + velocityScore);

  const label: MomentumLabel =
    score >= 80 ? "STRONG_IMPULSE" :
    score >= 60 ? "GOOD_TREND"     :
    score >= 40 ? "WEAK"           :
    "NO_TRADE";

  const { exhausted, reasons } = detectExhaustion(open, high, low, close, atr, ema20, rsi);

  // When exhaustion is detected, clamp score down
  const effectiveScore = exhausted ? Math.min(score, 55) : score;
  const effectiveLabel: MomentumLabel =
    effectiveScore >= 80 ? "STRONG_IMPULSE" :
    effectiveScore >= 60 ? "GOOD_TREND"     :
    effectiveScore >= 40 ? "WEAK"           :
    "NO_TRADE";

  const tradeAllowed   = effectiveScore >= 60 && !exhausted;
  const stackingAllowed = effectiveScore >= 75 && !exhausted;
  const autoTradeOk    = effectiveScore >= 75 && !exhausted;

  // Contribution to weighted confidence model (0–20 points)
  const confidenceContrib =
    effectiveScore >= 80 ? 20 :
    effectiveScore >= 70 ? 16 :
    effectiveScore >= 60 ? 12 :
    effectiveScore >= 50 ? 7  : 2;

  const debugSummary = [
    `score=${effectiveScore}`,
    `label=${effectiveLabel}`,
    `body=${bodyScore}`,
    `atr=${atrScore}`,
    `slope=${slopeScore}`,
    `macd=${macdScore}`,
    `persist=${persistScore}`,
    `vel=${velocityScore}`,
    exhausted ? `EXHAUSTED:[${reasons.slice(0,2).join("|")}]` : "",
  ].filter(Boolean).join(" | ");

  return {
    score:              effectiveScore,
    label:              effectiveLabel,
    bodyScore,
    atrScore,
    slopeScore,
    macdScore,
    persistScore,
    velocityScore,
    tradeAllowed,
    stackingAllowed,
    autoTradeOk,
    exhaustionDetected: exhausted,
    exhaustionReasons:  reasons,
    confidenceContrib,
    debugSummary,
  };
}
