// ── Advanced Momentum Reversal + Smart Trend Understanding Engine ────────────
// Companion module to goldService.ts.  No imports from goldService — all
// types are defined locally to avoid circular dependencies.  TypeScript's
// structural typing means ExtendedIndicators satisfies AdvancedEngineInput
// automatically.

// ── Local OHLC type ──────────────────────────────────────────────────────────
interface EngineOHLC {
  open:   number[];
  high:   number[];
  low:    number[];
  close:  number[];
  volume: number[];
}

// ── Subset of ExtendedIndicators needed by this module ───────────────────────
export interface AdvancedEngineInput {
  rsi:               number;
  prevRsi:           number;
  ema20:             number;
  ema50:             number;
  macdHistogram:     number;
  prevMacdHistogram: number;
  atr:               number;
  trendDirection:    "BULLISH" | "BEARISH" | "SIDEWAYS";
  trendStrength:     "STRONG" | "WEAK" | "RANGE";
  exhausted:         boolean;
  trap:              string | null;
  isStrongTrend:     boolean;
  isTrending:        boolean;
  body:              number;
  lastCandleBullish: boolean;
  momentumBias:      "BULLISH" | "BEARISH" | "NEUTRAL";
  momentumScore:     number;
  rsiRising:         boolean;
  rsiDecreasing:     boolean;
  swingHigh1:        number;
  swingHigh2:        number;
  swingLow1:         number;
  swingLow2:         number;
}

export type TrendState =
  | "TRENDING_STRONG"
  | "TRENDING_WEAK"
  | "REVERSAL_STARTING"
  | "CHOPPY"
  | "EXHAUSTED_TREND"
  | "BREAKOUT_BUILDUP"
  | "LIQUIDITY_TRAP";

export interface AdvancedDebugInfo {
  rsiDivergence:        string;
  macdDecay:            string;
  oppositeDisplacement: string;
  reversalFactors:      string[];
  gradeFactors:         string[];
  confidenceAdj:        number;
}

export interface AdvancedAnalysis {
  rsiDivergenceBearish:           boolean;
  rsiDivergenceBullish:           boolean;
  macdDecaying:                   boolean;
  macdDecayDirection:             "BULLISH_WEAKENING" | "BEARISH_WEAKENING" | "NONE";
  bearishDisplacementInBullTrend: boolean;
  bullishDisplacementInBearTrend: boolean;
  trendState:                     TrendState;
  reversalRisk:                   "HIGH" | "MEDIUM" | "LOW";
  reversalRiskReasons:            string[];
  signalGrade:                    "A+" | "A" | "B" | "C" | "D";
  confidenceAdjustment:           number;
  activeWarnings:                 string[];
  debugInfo:                      AdvancedDebugInfo;
}

// ── Math helpers (self-contained — no imports) ───────────────────────────────

function calcEMALocal(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const seed = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out: number[] = [seed];
  for (let i = period; i < data.length; i++) {
    out.push(data[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

function calcRSILocal(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

// Returns last `lookback` MACD(12,26,9) histogram values, most-recent last.
function calcMACDHistSeries(closes: number[], lookback = 5): number[] {
  if (closes.length < 50) return [];
  const ema12 = calcEMALocal(closes, 12);
  const ema26 = calcEMALocal(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return [];
  // Align to the shorter series (ema26) — both are right-aligned (last = current bar).
  const len = ema26.length;
  const ema12a = ema12.slice(ema12.length - len);
  const macdLine = ema12a.map((v, i) => v - ema26[i]);
  const signal = calcEMALocal(macdLine, 9);
  if (signal.length === 0) return [];
  const hLen = signal.length;
  const macdA = macdLine.slice(macdLine.length - hLen);
  const hist = macdA.map((v, i) => v - signal[i]);
  return hist.slice(-lookback);
}

// ── Analysis sub-functions ───────────────────────────────────────────────────

interface DivResult { bearish: boolean; bullish: boolean; details: string }

function detectRSIDivergence(closes: number[]): DivResult {
  const LOOKBACK = 8;
  if (closes.length < LOOKBACK + 20) {
    return { bearish: false, bullish: false, details: "insufficient data" };
  }
  const priceNow  = closes[closes.length - 1];
  const priceBack = closes[closes.length - 1 - LOOKBACK];
  const rsiNow    = calcRSILocal(closes, 14);
  const rsiBack   = calcRSILocal(closes.slice(0, closes.length - LOOKBACK), 14);

  const PRICE_THRESH = 0.00015; // ~0.015 % movement to call it directional
  const RSI_THRESH   = 2.5;     // minimum RSI divergence to be meaningful

  const priceUp   = priceNow  > priceBack * (1 + PRICE_THRESH);
  const priceDown = priceNow  < priceBack * (1 - PRICE_THRESH);
  const rsiDown   = rsiNow    < rsiBack - RSI_THRESH;
  const rsiUp     = rsiNow    > rsiBack + RSI_THRESH;

  const bearish = priceUp   && rsiDown;
  const bullish = priceDown && rsiUp;

  const dp = (priceNow - priceBack).toFixed(2);
  const dr = (rsiNow   - rsiBack ).toFixed(1);
  const details = bearish ? `P↑${dp} RSI↓${dr} → bearish div`
    : bullish             ? `P↓${Math.abs(parseFloat(dp)).toFixed(2)} RSI↑${dr} → bullish div`
    : `no div (dP=${dp} dRSI=${dr})`;

  return { bearish, bullish, details };
}

interface MACDResult {
  decaying:  boolean;
  direction: "BULLISH_WEAKENING" | "BEARISH_WEAKENING" | "NONE";
  details:   string;
}

function detectMACDDecay(closes: number[]): MACDResult {
  const hist = calcMACDHistSeries(closes, 5);
  if (hist.length < 4) {
    return { decaying: false, direction: "NONE", details: "insufficient data" };
  }

  const last4 = hist.slice(-4); // [oldest → newest]

  const allPos = last4.every(v => v > 0);
  const allNeg = last4.every(v => v < 0);

  // Bullish weakening: histogram was positive but each bar is smaller → fading bullish momentum
  if (allPos) {
    const shrinking = last4[1] < last4[0] && last4[2] < last4[1] && last4[3] < last4[2];
    if (shrinking) {
      return {
        decaying: true,
        direction: "BULLISH_WEAKENING",
        details: `hist: ${last4.map(v => v.toFixed(3)).join("→")} (bull fading)`,
      };
    }
  }

  // Bearish weakening: histogram was negative but each bar is closer to 0 → fading bearish momentum
  if (allNeg) {
    const shrinking = last4[1] > last4[0] && last4[2] > last4[1] && last4[3] > last4[2];
    if (shrinking) {
      return {
        decaying: true,
        direction: "BEARISH_WEAKENING",
        details: `hist: ${last4.map(v => v.toFixed(3)).join("→")} (bear fading)`,
      };
    }
  }

  return {
    decaying: false,
    direction: "NONE",
    details: `hist: ${last4.map(v => v.toFixed(3)).join("→")} (stable)`,
  };
}

interface DispResult { bearishInBull: boolean; bullishInBear: boolean; details: string }

function detectOppositeDisplacement(ohlc: EngineOHLC, ind: AdvancedEngineInput): DispResult {
  const { open, close } = ohlc;
  const n = Math.min(open.length, close.length);
  if (n < 3 || ind.atr <= 0) {
    return { bearishInBull: false, bullishInBear: false, details: "insufficient data" };
  }

  const STRONG_THRESH = 0.65; // body must be > 0.65 × ATR to be "strong"
  const threshold = ind.atr * STRONG_THRESH;

  // Inspect the last 2 closed candles
  const last2: Array<{ bull: boolean; body: number }> = [];
  for (let i = n - 2; i < n; i++) {
    last2.push({ bull: close[i] > open[i], body: Math.abs(close[i] - open[i]) });
  }

  const bearishInBull = ind.trendDirection === "BULLISH"
    && last2.every(c => !c.bull && c.body >= threshold);

  const bullishInBear = ind.trendDirection === "BEARISH"
    && last2.every(c => c.bull && c.body >= threshold);

  const bodies = last2.map(c => c.body.toFixed(2)).join(",");
  const details = bearishInBull ? `2 strong bear candles in bull (bodies:${bodies} thr:${threshold.toFixed(2)})`
    : bullishInBear              ? `2 strong bull candles in bear (bodies:${bodies} thr:${threshold.toFixed(2)})`
    : `no displacement`;

  return { bearishInBull, bullishInBear, details };
}

function classifyAdvancedTrendState(
  ind:           AdvancedEngineInput,
  chopScore:     number,
  divBearish:    boolean,
  divBullish:    boolean,
  macdDecaying:  boolean,
  bearishDisp:   boolean,
  bullishDisp:   boolean,
): TrendState {
  if (ind.trap !== null) return "LIQUIDITY_TRAP";

  const reversalSignals =
    (divBearish  ? 1 : 0) +
    (divBullish  ? 1 : 0) +
    (bearishDisp ? 1 : 0) +
    (bullishDisp ? 1 : 0) +
    (ind.exhausted ? 1 : 0);

  if (reversalSignals >= 2) return "REVERSAL_STARTING";

  if (ind.exhausted && macdDecaying) return "EXHAUSTED_TREND";
  if (ind.exhausted) return "EXHAUSTED_TREND";
  if (macdDecaying && reversalSignals >= 1) return "EXHAUSTED_TREND";

  if (chopScore > 0.6) return "CHOPPY";

  if (ind.isStrongTrend) return "TRENDING_STRONG";
  if (ind.isTrending)    return "TRENDING_WEAK";

  return "BREAKOUT_BUILDUP";
}

function assessReversalRisk(
  ind:           AdvancedEngineInput,
  divBearish:    boolean,
  divBullish:    boolean,
  macdDecaying:  boolean,
  macdDir:       string,
  bearishDisp:   boolean,
  bullishDisp:   boolean,
  currentSignal: string,
): { risk: "HIGH" | "MEDIUM" | "LOW"; reasons: string[] } {
  const reasons: string[] = [];

  if (currentSignal === "BUY") {
    if (divBearish)                                   reasons.push("RSI bearish divergence — price rising but RSI fading");
    if (bearishDisp)                                  reasons.push("2 strong bearish candles displaced into bull trend");
    if (macdDecaying && macdDir === "BULLISH_WEAKENING") reasons.push("MACD bullish histogram shrinking (3+ bars)");
    if (ind.exhausted)                                reasons.push("Candle exhaustion (3+ consecutive wicks)");
    if (ind.trendStrength === "RANGE")                reasons.push("Trend is ranging — no clear directional push");
    if (ind.swingHigh2 < ind.swingHigh1)              reasons.push("Lower highs forming — bearish structure");
  } else if (currentSignal === "SELL") {
    if (divBullish)                                   reasons.push("RSI bullish divergence — price falling but RSI rising");
    if (bullishDisp)                                  reasons.push("2 strong bullish candles displaced into bear trend");
    if (macdDecaying && macdDir === "BEARISH_WEAKENING") reasons.push("MACD bearish histogram shrinking (3+ bars)");
    if (ind.exhausted)                                reasons.push("Candle exhaustion (3+ consecutive wicks)");
    if (ind.trendStrength === "RANGE")                reasons.push("Trend is ranging — no clear directional push");
    if (ind.swingLow2 > ind.swingLow1)                reasons.push("Higher lows forming — bullish structure");
  } else {
    if (ind.exhausted)  reasons.push("Candle exhaustion detected");
    if (macdDecaying)   reasons.push("MACD histogram decaying");
    if (ind.trendStrength === "RANGE") reasons.push("Range-bound market");
  }

  const risk: "HIGH" | "MEDIUM" | "LOW" =
    reasons.length >= 3 ? "HIGH"   :
    reasons.length >= 1 ? "MEDIUM" : "LOW";

  return { risk, reasons };
}

function gradeSignal(
  score:         number,
  riskFactors:   number,
  reversalRisk:  "HIGH" | "MEDIUM" | "LOW",
  trendState:    TrendState,
  ind:           AdvancedEngineInput,
  macdDecaying:  boolean,
  divDetected:   boolean,
  currentSignal: string,
): "A+" | "A" | "B" | "C" | "D" {
  if (currentSignal === "HOLD" || currentSignal === "CONFLICT") return "D";

  // Grade D — disqualifying conditions
  if (reversalRisk === "HIGH")                          return "D";
  if (trendState === "LIQUIDITY_TRAP")                  return "D";
  if (score < 2)                                        return "D";

  // Grade C
  if (score < 3)                                        return "C";
  if (trendState === "REVERSAL_STARTING")               return "C";
  if (trendState === "CHOPPY")                          return "C";
  if (macdDecaying && divDetected)                      return "C";

  // Grade B
  if (score < 5)                                        return "B";
  if (macdDecaying || divDetected)                      return "B";
  if (trendState === "EXHAUSTED_TREND")                 return "B";
  if (reversalRisk === "MEDIUM" && riskFactors >= 2)    return "B";

  // Grade A
  if (score < 7)                                        return "A";
  if (!ind.isStrongTrend)                               return "A";
  if (reversalRisk === "MEDIUM")                        return "A";

  // Grade A+ — everything clean, strong trend, high score, low risk
  return "A+";
}

function computeConfidenceAdjustment(
  divBearish:    boolean,
  divBullish:    boolean,
  macdDecaying:  boolean,
  macdDir:       string,
  bearishDisp:   boolean,
  bullishDisp:   boolean,
  trendState:    TrendState,
  reversalRisk:  "HIGH" | "MEDIUM" | "LOW",
  chopScore:     number,
  ind:           AdvancedEngineInput,
  currentSignal: string,
): { adjustment: number; breakdown: Array<{ factor: string; adjustment: number }> } {
  const breakdown: Array<{ factor: string; adjustment: number }> = [];
  let adj = 0;

  const push = (factor: string, val: number) => { adj += val; breakdown.push({ factor, adjustment: val }); };

  if (currentSignal === "BUY") {
    if (divBearish)                                       push("RSI bearish divergence",             -15);
    if (bearishDisp)                                      push("Bearish displacement in bull trend",  -12);
    if (macdDecaying && macdDir === "BULLISH_WEAKENING")  push("MACD bullish momentum fading",        -8);
  } else if (currentSignal === "SELL") {
    if (divBullish)                                       push("RSI bullish divergence",              -15);
    if (bullishDisp)                                      push("Bullish displacement in bear trend",  -12);
    if (macdDecaying && macdDir === "BEARISH_WEAKENING")  push("MACD bearish momentum fading",        -8);
  }

  // Direction-agnostic adjustments
  if (trendState === "REVERSAL_STARTING")                 push("Reversal starting",                  -10);
  else if (trendState === "EXHAUSTED_TREND")              push("Trend exhausted",                     -8);

  if (trendState === "CHOPPY" || chopScore > 0.6)         push("Choppy market",                       -8);
  if (reversalRisk === "HIGH")                            push("Reversal risk HIGH",                  -5);

  // Small bonus for clean strong-trend continuation
  if (
    trendState === "TRENDING_STRONG" && !macdDecaying &&
    !divBearish && !divBullish && reversalRisk === "LOW" && ind.isStrongTrend
  ) {
    push("Strong trend continuation bonus", +5);
  }

  return { adjustment: Math.max(-25, Math.min(5, adj)), breakdown };
}

function buildActiveWarnings(
  divBearish:    boolean,
  divBullish:    boolean,
  macdDecaying:  boolean,
  macdDir:       string,
  bearishDisp:   boolean,
  bullishDisp:   boolean,
  trendState:    TrendState,
  reversalRisk:  "HIGH" | "MEDIUM" | "LOW",
  ind:           AdvancedEngineInput,
  currentSignal: string,
): string[] {
  const w: string[] = [];

  if (currentSignal === "BUY") {
    if (divBearish)                                      w.push("MOMENTUM REVERSING");
    if (bearishDisp)                                     w.push("STRONG IMPULSE AGAINST");
    if (macdDecaying && macdDir === "BULLISH_WEAKENING") w.push("MACD WEAKENING");
  } else if (currentSignal === "SELL") {
    if (divBullish)                                      w.push("MOMENTUM REVERSING");
    if (bullishDisp)                                     w.push("STRONG IMPULSE AGAINST");
    if (macdDecaying && macdDir === "BEARISH_WEAKENING") w.push("MACD WEAKENING");
  } else {
    if (macdDecaying)               w.push("MACD WEAKENING");
    if (divBearish || divBullish)   w.push("MOMENTUM DIVERGENCE");
  }

  if (trendState === "EXHAUSTED_TREND" || ind.exhausted)  w.push("TREND EXHAUSTED");
  if (trendState === "REVERSAL_STARTING")                  w.push("REVERSAL STARTING");
  if (trendState === "LIQUIDITY_TRAP")                     w.push("LIQUIDITY TRAP");
  if (trendState === "CHOPPY")                             w.push("CHOPPY MARKET");
  if (reversalRisk === "HIGH")                             w.push("REVERSAL RISK HIGH");

  // Deduplicate while preserving priority order
  return [...new Set(w)];
}

// ── Main Export ──────────────────────────────────────────────────────────────

export function runAdvancedAnalysis(
  ohlc:          EngineOHLC,
  ind:           AdvancedEngineInput,
  chopScore:     number,
  currentScore:  number,
  currentSignal: string,
): AdvancedAnalysis {
  // Filter out zero/NaN/Infinity from close prices (mirrors goldService's cleanArray)
  const closes = ohlc.close.filter(v => v > 0 && isFinite(v));

  const divResult  = detectRSIDivergence(closes);
  const macdResult = detectMACDDecay(closes);
  const dispResult = detectOppositeDisplacement(ohlc, ind);

  const trendState = classifyAdvancedTrendState(
    ind, chopScore,
    divResult.bearish, divResult.bullish,
    macdResult.decaying,
    dispResult.bearishInBull, dispResult.bullishInBear,
  );

  const { risk, reasons } = assessReversalRisk(
    ind,
    divResult.bearish, divResult.bullish,
    macdResult.decaying, macdResult.direction,
    dispResult.bearishInBull, dispResult.bullishInBear,
    currentSignal,
  );

  // "divergence detected" is directional — only fire when it opposes the signal
  const divDetected =
    (currentSignal === "BUY"  && divResult.bearish) ||
    (currentSignal === "SELL" && divResult.bullish);

  const signalGrade = gradeSignal(
    currentScore, reasons.length, risk, trendState,
    ind, macdResult.decaying, divDetected, currentSignal,
  );

  const { adjustment, breakdown } = computeConfidenceAdjustment(
    divResult.bearish, divResult.bullish,
    macdResult.decaying, macdResult.direction,
    dispResult.bearishInBull, dispResult.bullishInBear,
    trendState, risk, chopScore, ind, currentSignal,
  );

  const activeWarnings = buildActiveWarnings(
    divResult.bearish, divResult.bullish,
    macdResult.decaying, macdResult.direction,
    dispResult.bearishInBull, dispResult.bullishInBear,
    trendState, risk, ind, currentSignal,
  );

  const gradeFactors: string[] = [];
  if (currentScore >= 7) gradeFactors.push(`score=${currentScore} (excellent)`);
  else if (currentScore >= 5) gradeFactors.push(`score=${currentScore} (good)`);
  else if (currentScore >= 3) gradeFactors.push(`score=${currentScore} (moderate)`);
  else gradeFactors.push(`score=${currentScore} (weak)`);
  if (divDetected)          gradeFactors.push("divergence vs signal");
  if (macdResult.decaying)  gradeFactors.push(`MACD ${macdResult.direction.toLowerCase()}`);
  if (ind.exhausted)        gradeFactors.push("candle exhaustion");
  if (ind.isStrongTrend)    gradeFactors.push("strong trend confirmed");
  if (risk !== "LOW")       gradeFactors.push(`reversal risk ${risk}`);

  return {
    rsiDivergenceBearish:           divResult.bearish,
    rsiDivergenceBullish:           divResult.bullish,
    macdDecaying:                   macdResult.decaying,
    macdDecayDirection:             macdResult.direction,
    bearishDisplacementInBullTrend: dispResult.bearishInBull,
    bullishDisplacementInBearTrend: dispResult.bullishInBear,
    trendState,
    reversalRisk:                   risk,
    reversalRiskReasons:            reasons,
    signalGrade,
    confidenceAdjustment:           adjustment,
    activeWarnings,
    debugInfo: {
      rsiDivergence:        divResult.details,
      macdDecay:            macdResult.details,
      oppositeDisplacement: dispResult.details,
      reversalFactors:      reasons,
      gradeFactors,
      confidenceAdj:        adjustment,
    },
  };
}
