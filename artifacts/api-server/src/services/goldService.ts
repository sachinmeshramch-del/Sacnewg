import { getFinnhubPrice, isFinnhubConnected } from "./finnhubService.js";
import { getSpotPrice } from "./spotGoldService.js";

// ── Types ──────────────────────────────────────────────────────────────────────
interface OHLCData {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamps: number[];
}

interface PriceData {
  price: number;
  change: number;
  changePercent: number;
  high24h: number;
  low24h: number;
  timestamp: string;
  source?: "finnhub" | "yahoo" | "fallback" | "gold-api" | "stooq";
}

interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  atr: number;
}

// ── Signal Decision Layer (NEW) ──────────────────────────────────────────────
// `signal` answers WHAT the engine sees (direction).
// `permission` answers WHETHER the user should act on it.
// They are intentionally split: a BUY with mixed evidence becomes
// signal=BUY + permission=WATCHLIST (no trade levels, just context).
type IndicatorVote = "BULLISH" | "BEARISH" | "NEUTRAL";
interface IndicatorBias {
  ema:       IndicatorVote;  // trend filter (EMA20 vs EMA50)
  macd:      IndicatorVote;  // momentum confirmation (MACD line vs signal)
  rsi:       IndicatorVote;  // timing condition (RSI vs 50)
  momentum:  IndicatorVote;  // Trend Memory (last 8 candles)
  htf:       IndicatorVote;  // higher TF (15m) trend
  structure: IndicatorVote;  // HH/HL vs LL/LH market structure
}

interface SignalResult {
  signal: "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
  confidence: number;
  // Permission gate — ACTIONABLE > QUALIFIED > WATCHLIST > BLOCKED.
  // Only QUALIFIED+ shows trade levels. WATCHLIST is "context only".
  permission?: "ACTIONABLE" | "QUALIFIED" | "WATCHLIST" | "BLOCKED";
  entry: number;
  stopLoss: number;
  takeProfit: number;       // = tp2 (final target, 2.2× risk)
  tp1?: number;             // partial target, 1.2× risk
  tp2?: number;             // final target, 2.2× risk (mirrors takeProfit)
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  trendStrength?: "STRONG" | "WEAK" | "RANGE";
  marketMode: "TRENDING" | "SIDEWAYS";
  // Higher-resolution market regime (NEW). Drives the conflict / chop logic.
  marketRegime?: "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "CHOPPY" | "TRANSITION";
  signalLabel?: string;
  signalStatus?: "PENDING" | "CONFIRMED";
  signalType?: "TREND" | "REVERSAL";
  higherTrend?: "BULLISH" | "BEARISH" | "NEUTRAL";
  // mtfStatus: SUPPORTIVE = HTF agrees with entry; NEUTRAL = HTF flat;
  // CONTRA = HTF disagrees (trade is allowed, just scores -2 on HTF axis).
  // Legacy values (WAITING/ALIGNED/BLOCKED/SETUP_FORMING) preserved for
  // backwards compat but the new score engine emits SUPPORTIVE/NEUTRAL/CONTRA.
  mtfStatus?: "WAITING" | "ALIGNED" | "BLOCKED" | "SETUP_FORMING" | "SUPPORTIVE" | "NEUTRAL" | "CONTRA";
  // Score-based engine outputs (NEW). signalStrength is the qualitative
  // bucket; score is the raw 0..10ish weighted total used to derive it.
  signalStrength?: "STRONG" | "NORMAL" | "WEAK" | "NONE";
  score?: number;
  scoreBreakdown?: {
    ema: number;
    htf: number;
    momentum: number;
    pullback: number;
    confirmation: number;
    breakout: number;
    trap: number;
    volatility: number;
    // Volume confirmation axes (boosters only — never block a trade).
    volume: number;          // +0/+1/+2 from current vs 20-bar SMA
    breakoutVolume: number;  // +2 valid / -1 weak / 0
    pullbackVolume: number;  // +2 bonus when zone+rejection prints w/ volume
    stopHunt: number;        // +2 long opposite-side wick + above-avg volume
    total: number;
  };
  entryQuality?: "EARLY" | "CONFIRMED";
  marketState?: "TRENDING" | "EXHAUSTED" | "REVERSAL_WATCH";
  blockReason?: string;
  // Indicator Conflict Engine (NEW) — surfaces WHY a setup isn't tradable.
  conflictLevel?: "NONE" | "MINOR" | "MIXED" | "SEVERE";
  conflictReasons?: string[];
  indicatorBias?: IndicatorBias;
  // Chop / Volatility filter (NEW) — 0..1, > 0.6 = consolidation / chop.
  chopScore?: number;
  // Soft user-facing banner ("Mixed indicators — waiting for structure
  // confirmation", "Bearish trend context", etc.). Set by the UI Decision
  // Engine layer, separate from signalLabel.
  bannerMessage?: string;
  zoneStatus?: "BUY_ZONE" | "SELL_ZONE" | "NO_ZONE";
  pullbackConfirmation?: "WAITING" | "REJECTION_DETECTED";
  // Pullback State Detector — separate from zoneStatus; based on EMA20/EMA50 position.
  pullbackState?: "BULLISH_PULLBACK" | "BEARISH_PULLBACK" | "NONE";
  // Trend Memory — momentum bias from net price move over the last 5–10 candles.
  momentumBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  momentumScore?: number; // signed; |score| ≥ 0.6 = strong recent move
  timeframe: string;
  indicators: Indicators;
  timestamp: string;
}

export interface HistoryItem {
  id: number;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  trend: string;
  timeframe: string;
  timestamp: string;
  outcome: "WIN" | "LOSS" | "PENDING" | null;
  permission?: "ACTIONABLE" | "QUALIFIED" | "WATCHLIST" | "BLOCKED";
  signalStatus?: "CONFIRMED" | "PENDING";
  // Confidence-derived classification used by the UI to split signals into
  // STRONG / MODERATE / WEAK tables. STRONG ≥ 65, MODERATE ≥ 50, WEAK ≥ 35,
  // IGNORE below 35.
  signalType?: "STRONG" | "MODERATE" | "WEAK" | "IGNORE";
}

/** Classify a signal by its confidence score. */
export function classifySignalByConfidence(
  confidence: number,
): "STRONG" | "MODERATE" | "WEAK" | "IGNORE" {
  if (confidence >= 65) return "STRONG";
  if (confidence >= 50) return "MODERATE";
  // Everything from 0–49 is now classified as WEAK (per spec).
  // IGNORE is retained in the type for backwards compatibility but is no
  // longer produced by classification.
  return "WEAK";
}

// ── History Persistence ────────────────────────────────────────────────────────
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HISTORY_FILE = join(process.cwd(), "signal_history.json");

function loadHistory(): { items: HistoryItem[]; counter: number } {
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return { items: parsed.items ?? [], counter: parsed.counter ?? 1 };
    }
  } catch { /* start fresh on corrupt file */ }
  return { items: [], counter: 1 };
}

function saveHistory() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify({ items: signalHistory, counter: historyIdCounter }, null, 2));
  } catch { /* non-fatal */ }
}

// ── Memory & Cache ─────────────────────────────────────────────────────────────
const _loaded = loadHistory();
let signalHistory: HistoryItem[] = _loaded.items;
let historyIdCounter = _loaded.counter;

interface SignalMemory {
  signal: "BUY" | "SELL";
  price: number;
  timestamp: number;
}

const lastSignalMemory: Record<string, SignalMemory | null> = {
  "1m": null,
  "5m": null,
};

interface PendingSignal {
  signal: "BUY" | "SELL";
  firstCandleTs: number;
  lastCandleTs: number;
  candleCount: number;
}

const pendingSignal: Record<string, PendingSignal | null> = {
  "1m": null,
  "5m": null,
};

interface ActiveTrade {
  signal: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  timestamp: number;
}

const activeTrade: Record<string, ActiveTrade | null> = {
  "1m": null,
  "5m": null,
};

/** Resolves an open trade if TP/SL hit or 10-min timeout exceeded. */
function checkActiveTrade(tf: string, currentPrice: number): ActiveTrade | null {
  const t = activeTrade[tf];
  if (!t) return null;
  // Auto-clear on timeout
  if (Date.now() - t.timestamp > ACTIVE_TRADE_TIMEOUT_MS) {
    activeTrade[tf] = null;
    return null;
  }
  // Auto-clear on TP / SL hit
  if (t.signal === "BUY") {
    if (currentPrice >= t.takeProfit || currentPrice <= t.stopLoss) {
      activeTrade[tf] = null;
      return null;
    }
  } else {
    if (currentPrice <= t.takeProfit || currentPrice >= t.stopLoss) {
      activeTrade[tf] = null;
      return null;
    }
  }
  return t;
}

interface PrevState {
  rsi: number;
  macdHistogram: number;
  atr: number;
}

const prevState: Record<string, PrevState | null> = {
  "1m": null,
  "5m": null,
};

// 3-minute cooldown after any confirmed signal
const COOLDOWN_MS = 3 * 60 * 1000;
// Confidence thresholds
const MIN_CONFIDENCE_TREND = 65;     // trend-following minimum
const MIN_CONFIDENCE_REVERSAL = 75;  // counter-trend / reversal minimum
// Bars of confirmation required before tradable
const CONFIRMATION_CANDLES = 2;

// ── Data Fetching ──────────────────────────────────────────────────────────────
async function fetchYahooFinance(symbol: string, interval: string, range: string): Promise<OHLCData | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
      }
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const chart = data?.chart?.result?.[0];
    if (!chart) return null;

    const timestamps = chart.timestamp as number[];
    const quote = chart.indicators?.quote?.[0];
    if (!timestamps || !quote) return null;

    return {
      open: quote.open as number[],
      high: quote.high as number[],
      low: quote.low as number[],
      close: quote.close as number[],
      volume: quote.volume as number[],
      timestamps,
    };
  } catch {
    return null;
  }
}

// ── Math Utilities ─────────────────────────────────────────────────────────────
function cleanArray(arr: number[]): number[] {
  return arr.map(v => (v == null || isNaN(v) ? 0 : v));
}

function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [closes[closes.length - 1] ?? 0];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(prev);
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(highs: number[], lows: number[], closes: number[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length === 0) return 1;
  if (trs.length < period) return trs[trs.length - 1];
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Session Filter ─────────────────────────────────────────────────────────────
// London: 07:00–16:00 UTC | New York: 13:00–22:00 UTC
// Combined active window: 07:00–22:00 UTC
function isActiveTradingSession(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const inLondon = utcHour >= 7 && utcHour < 16;
  const inNewYork = utcHour >= 13 && utcHour < 22;
  return inLondon || inNewYork;
}

function getSessionName(): string {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const inLondon = utcHour >= 7 && utcHour < 16;
  const inNewYork = utcHour >= 13 && utcHour < 22;
  if (inLondon && inNewYork) return "London/NY Overlap";
  if (inLondon) return "London";
  if (inNewYork) return "New York";
  return "Asian (inactive)";
}

// ── Price Action Bias ──────────────────────────────────────────────────────────
// Detect HH+HL (bullish) or LH+LL (bearish) over last N candles
function getPriceActionBias(highs: number[], lows: number[], n = 5): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (highs.length < n + 1 || lows.length < n + 1) return "NEUTRAL";
  const rh = highs.slice(-n);
  const rl = lows.slice(-n);
  let hhCount = 0, hlCount = 0, lhCount = 0, llCount = 0;
  for (let i = 1; i < rh.length; i++) {
    if (rh[i] > rh[i - 1]) hhCount++; else lhCount++;
    if (rl[i] > rl[i - 1]) hlCount++; else llCount++;
  }
  const bullishBars = hhCount + hlCount;
  const bearishBars = lhCount + llCount;
  const total = (n - 1) * 2;
  if (bullishBars >= total * 0.65) return "BULLISH";
  if (bearishBars >= total * 0.65) return "BEARISH";
  return "NEUTRAL";
}

// ── Extended Indicators ────────────────────────────────────────────────────────
type TrapKind =
  | "FAKE_BREAKOUT_SELL"   // Bull trap: broke resistance, closed back below + upper wick
  | "FAKE_BREAKDOWN_BUY"   // Bear trap: broke support, closed back above + lower wick
  | "STOP_HUNT_SELL"       // Liquidity grab above highs, sharp bearish rejection
  | "STOP_HUNT_BUY";       // Liquidity grab below lows, sharp bullish rejection

interface ExtendedIndicators extends Indicators {
  prevMacdHistogram: number;
  prevAtr: number;
  priceActionBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  lastCandleBullish: boolean;
  breaksPrevHigh: boolean;
  breaksPrevLow: boolean;
  // Price-action structure for trap detection
  resistance: number;          // highest high of prior N candles (excluding current)
  support: number;             // lowest low of prior N candles  (excluding current)
  upperWick: number;
  lowerWick: number;
  body: number;                // |open - close|
  wickRatio: number;           // max(upper, lower) / max(body, ε)
  trap: TrapKind | null;
  // Momentum exhaustion + reversal-watch detection
  exhausted: boolean;                     // last 3 candles small body + long wicks
  reversalWatchSide: "BULLISH" | "BEARISH" | null; // big impulse + rejection wick
  marketState: "TRENDING" | "EXHAUSTED" | "REVERSAL_WATCH";
  // Smart Trend Engine — combines EMA + market structure (swing HH/HL/LH/LL)
  trendDirection: "BULLISH" | "BEARISH" | "SIDEWAYS";
  trendStrength: "STRONG" | "WEAK" | "RANGE";
  swingHigh1: number;   // most recent confirmed swing high
  swingHigh2: number;   // previous swing high
  swingLow1:  number;   // most recent confirmed swing low
  swingLow2:  number;   // previous swing low
  // Pullback Entry Engine — zone + rejection-candle confirmation
  pullbackRange: number;                                    // ATR*0.5, clamped 3..6 pts
  zoneStatus: "BUY_ZONE" | "SELL_ZONE" | "NO_ZONE";
  pullbackConfirmation: "WAITING" | "REJECTION_DETECTED";
  // Pullback State — based on EMA20/EMA50 position relative to current price.
  // Independent of zoneStatus (which can fire on either retracement or near-EMA20).
  pullbackState: "BULLISH_PULLBACK" | "BEARISH_PULLBACK" | "NONE";
  // Trend Memory — net price impulse over the last 5–10 candles, signed,
  // normalised by ATR. |score| ≥ 0.6 = strong recent move that overrides a
  // SIDEWAYS classification (prevents false sideways during pullbacks).
  momentumBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  momentumScore: number;
  // Volume + breakout (NEW — fuels the score-engine breakout fallback).
  // volumeAvg = mean of prior 20 candle volumes; volumeLast = latest candle
  // volume; volumeSpike = last > 1.5× avg. strongBreakoutBuy/Sell fire when
  // the latest candle breaks the prior swing high/low with a wide body and
  // either a volume spike or an unusually wide range (volume-less fallback).
  volumeAvg: number;
  volumeLast: number;
  volumeSpike: boolean;
  strongBreakoutBuy: boolean;
  strongBreakoutSell: boolean;
}

const STRUCTURE_LOOKBACK = 15;          // candles to look back for swing high/low
const MIN_WICK_TO_BODY   = 1.5;          // wick must be 1.5x the body to qualify
const MIN_BODY_PCT       = 0.0003;       // body at least 0.03% of price (skip dojis)

// ── Smart Trend Engine constants ─────────────────────────────────────────────
const SWING_PIVOT_K              = 2;    // candle is a pivot if higher/lower than K bars on each side
const SWING_LOOKBACK             = 30;   // scan last 30 candles for pivots
const EMA_NEUTRAL_SEPARATION_PCT = 0.0008; // EMAs within 0.08% → SIDEWAYS bias

// ── Strict-Sideways Detection constants ─────────────────────────────────────
// Sideways now requires ALL three: flat EMA20, flat EMA50, AND a tight price
// range. Otherwise the market is TRENDING (even on light EMA separation).
const SIDEWAYS_EMA_SLOPE_PCT     = 0.0005; // EMA slope < 0.05% over the lookback = "flat"
const SIDEWAYS_SLOPE_LOOKBACK    = 5;      // measure slope across last 5 closed bars
const SIDEWAYS_RANGE_LOOKBACK    = 10;     // recent price range = max(highs) − min(lows) of last 10 bars
const SIDEWAYS_RANGE_ATR_MULT    = 2.0;    // tight range = recent range < ATR × 2

// ── Trend Memory (Momentum) constants ───────────────────────────────────────
// Net price move over last N candles, normalised by ATR. Strong recent moves
// keep a directional bias even if EMAs flatten — kills "false SIDEWAYS during
// pullbacks" by giving the trend a memory window.
const MOMENTUM_LOOKBACK          = 8;      // 5–10 candles, mid value
const MOMENTUM_ATR_DIVISOR       = 1.5;    // score = netMove / (ATR × 1.5)
const MOMENTUM_BIAS_THRESHOLD    = 0.6;    // |score| ≥ 0.6 → directional bias

// ── Pullback Zone (expanded) constants ──────────────────────────────────────
// Zone is now active on EITHER price-near-EMA20 OR a 30–50% retracement of
// the most recent confirmed swing leg.
const RETRACEMENT_MIN            = 0.30;
const RETRACEMENT_MAX            = 0.50;

// ── Trade-quality filter constants ───────────────────────────────────────────
const PRICE_DENSITY_RANGE_PTS    = 8;    // anti-stacking: same dir within 8pts → block
const OVEREXTENSION_ATR_MULT     = 0.8;  // BLOCK if price > EMA20 ± 0.8*ATR
const EXHAUSTION_LOOKBACK        = 3;    // last 3 candles for exhaustion check
const EXHAUSTION_BODY_PCT        = 0.0004; // body < 0.04% of price = "small"
const EXHAUSTION_WICK_TO_BODY    = 1.5;  // wick ≥ 1.5*body = "long wick"
const REVERSAL_IMPULSE_BODY_PCT  = 0.0008; // body > 0.08% = "strong impulse"
const PULLBACK_ATR_MULT          = 0.6;  // entry must be within 0.6*ATR of EMA20
const ACTIVE_TRADE_TIMEOUT_MS    = 10 * 60 * 1000; // 10-min auto-clear

function detectTrap(
  open: number, high: number, low: number, close: number,
  resistance: number, support: number,
  atr: number, price: number,
): TrapKind | null {
  const body      = Math.abs(open - close);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;

  // Filter: skip dojis / candles too small to be meaningful
  if (body < price * MIN_BODY_PCT) return null;
  // Filter: skip if ATR too low (chop) — handled by caller, but be safe
  if (atr <= 0) return null;

  // ── Bull trap / fake breakout SELL ──
  // High pierced resistance, close came back below, big upper wick
  if (high > resistance && close < resistance && upperWick > body * MIN_WICK_TO_BODY) {
    return "FAKE_BREAKOUT_SELL";
  }
  // ── Bear trap / fake breakdown BUY ──
  if (low < support && close > support && lowerWick > body * MIN_WICK_TO_BODY) {
    return "FAKE_BREAKDOWN_BUY";
  }
  // ── Stop hunt SELL — liquidity grab above prior high w/ strong bearish close ──
  // Spike above resistance, bearish body, very long upper wick relative to body
  if (high > resistance && close < open && upperWick > body * 2 && upperWick > atr * 0.5) {
    return "STOP_HUNT_SELL";
  }
  // ── Stop hunt BUY — liquidity grab below prior low w/ strong bullish close ──
  if (low < support && close > open && lowerWick > body * 2 && lowerWick > atr * 0.5) {
    return "STOP_HUNT_BUY";
  }
  return null;
}

// ── Smart Trend Engine ───────────────────────────────────────────────────────
// Pivot-based swing detection: a candle at index i is a swing high if its high
// is strictly greater than the K candles before and after. Same for lows.
// Returns the two most recent confirmed swings (most recent first).
function findSwings(highs: number[], lows: number[], k = SWING_PIVOT_K): {
  swingHighs: number[]; swingLows: number[];
} {
  const n = Math.min(highs.length, lows.length);
  const start = Math.max(k, n - SWING_LOOKBACK);
  const swingHighs: number[] = [];
  const swingLows: number[]  = [];
  // Note: cannot confirm a pivot for the very last K candles (no right-side context).
  for (let i = start; i < n - k; i++) {
    const h = highs[i];
    const l = lows[i];
    if (!(h > 0)) continue;
    let isHigh = true, isLow = l > 0;
    for (let j = 1; j <= k; j++) {
      if (highs[i - j] >= h || highs[i + j] >= h) isHigh = false;
      if (l > 0 && (lows[i - j] <= l || lows[i + j] <= l)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swingHighs.push(h);
    if (isLow)  swingLows.push(l);
  }
  // Most recent first
  swingHighs.reverse();
  swingLows.reverse();
  return { swingHighs, swingLows };
}

interface SmartTrend {
  direction: "BULLISH" | "BEARISH" | "SIDEWAYS";
  strength: "STRONG" | "WEAK" | "RANGE";
  swingHigh1: number;
  swingHigh2: number;
  swingLow1:  number;
  swingLow2:  number;
}

/** Strict sideways: ALL three must hold — flat EMA20, flat EMA50, tight range. */
function isStrictSideways(
  ema20Arr: number[], ema50Arr: number[],
  highs: number[], lows: number[], atr: number,
): boolean {
  if (ema20Arr.length < SIDEWAYS_SLOPE_LOOKBACK + 1) return false;
  if (ema50Arr.length < SIDEWAYS_SLOPE_LOOKBACK + 1) return false;
  const e20Last = ema20Arr[ema20Arr.length - 1];
  const e20Prev = ema20Arr[ema20Arr.length - 1 - SIDEWAYS_SLOPE_LOOKBACK];
  const e50Last = ema50Arr[ema50Arr.length - 1];
  const e50Prev = ema50Arr[ema50Arr.length - 1 - SIDEWAYS_SLOPE_LOOKBACK];
  const e20Slope = Math.abs(e20Last - e20Prev) / Math.max(e20Last, 1e-6);
  const e50Slope = Math.abs(e50Last - e50Prev) / Math.max(e50Last, 1e-6);
  const ema20Flat = e20Slope < SIDEWAYS_EMA_SLOPE_PCT;
  const ema50Flat = e50Slope < SIDEWAYS_EMA_SLOPE_PCT;
  if (!ema20Flat || !ema50Flat) return false;

  const recentHighs = highs.slice(-SIDEWAYS_RANGE_LOOKBACK).filter(x => x > 0);
  const recentLows  = lows.slice(-SIDEWAYS_RANGE_LOOKBACK).filter(x => x > 0);
  if (!recentHighs.length || !recentLows.length) return false;
  const range = Math.max(...recentHighs) - Math.min(...recentLows);
  return range < atr * SIDEWAYS_RANGE_ATR_MULT;
}

/** Momentum bias from net close-to-close move over the last N candles. */
function calcMomentum(closes: number[], atr: number): {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL"; score: number;
} {
  if (closes.length < MOMENTUM_LOOKBACK + 1 || atr <= 0) {
    return { bias: "NEUTRAL", score: 0 };
  }
  const last = closes[closes.length - 1];
  const ref  = closes[closes.length - 1 - MOMENTUM_LOOKBACK];
  if (!(last > 0) || !(ref > 0)) return { bias: "NEUTRAL", score: 0 };
  const net   = last - ref;
  const score = net / (atr * MOMENTUM_ATR_DIVISOR);
  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    score >=  MOMENTUM_BIAS_THRESHOLD ? "BULLISH" :
    score <= -MOMENTUM_BIAS_THRESHOLD ? "BEARISH" : "NEUTRAL";
  return { bias, score };
}

/**
 * Pullback Zone (expanded): zone is active when price is either near EMA20
 * (existing rule) OR retraced 30–50% of the most recent swing leg.
 * Direction-aware: BUY zone uses swingHigh→price retrace from the high,
 * SELL zone uses price→swingLow bounce off the low.
 */
function inExpandedPullbackZone(
  side: "BUY" | "SELL",
  price: number, ema20: number, atr: number,
  swingHigh: number, swingLow: number,
  pullbackRange: number,
): { active: boolean; via: "NEAR_EMA" | "RETRACEMENT" | "NONE" } {
  const nearEma20 = Math.abs(price - ema20) <= pullbackRange;
  if (nearEma20) return { active: true, via: "NEAR_EMA" };

  const range = Math.max(0, swingHigh - swingLow);
  if (range <= atr * 0.25) return { active: false, via: "NONE" }; // swing too small to mean anything

  const retrace = side === "BUY"
    ? (swingHigh - price) / range   // BULLISH pullback from the high
    : (price - swingLow)  / range;  // BEARISH bounce from the low
  if (retrace >= RETRACEMENT_MIN && retrace <= RETRACEMENT_MAX) {
    return { active: true, via: "RETRACEMENT" };
  }
  return { active: false, via: "NONE" };
}

/**
 * Smart Trend Engine — combines EMA bias with market structure.
 *
 *   STRONG BULLISH = EMA20 > EMA50  +  HH (lastHigh > prevHigh)  +  HL (lastLow > prevLow)
 *   WEAK BULLISH   = EMA20 > EMA50  but no HH (pullback / weakening)
 *   STRONG BEARISH = EMA20 < EMA50  +  LL (lastLow < prevLow)    +  LH (lastHigh < prevHigh)
 *   WEAK BEARISH   = EMA20 < EMA50  but no LL
 *   SIDEWAYS       = EMAs hugging or no structural conviction
 */
function classifySmartTrend(
  ema20Arr: number[], ema50Arr: number[], currentPrice: number,
  highs: number[], lows: number[], atr: number,
  momentumBias: "BULLISH" | "BEARISH" | "NEUTRAL",
): SmartTrend {
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];

  const { swingHighs, swingLows } = findSwings(highs, lows);
  const lastHigh = swingHighs[0] ?? Math.max(...highs.slice(-5).filter(x => x > 0), 0);
  const prevHigh = swingHighs[1] ?? lastHigh;
  const lastLow  = swingLows[0]  ?? Math.min(...lows.slice(-5).filter(x => x > 0),  Number.POSITIVE_INFINITY);
  const prevLow  = swingLows[1]  ?? lastLow;
  const swings = { swingHigh1: lastHigh, swingHigh2: prevHigh, swingLow1: lastLow, swingLow2: prevLow };

  const HH = lastHigh > prevHigh;     // higher high
  const LH = lastHigh <= prevHigh;    // lower (or equal) high
  const HL = lastLow  > prevLow;      // higher low
  const LL = lastLow  <= prevLow;     // lower (or equal) low

  const isBull = ema20 > ema50;
  const isBear = ema20 < ema50;

  // ── STRICT SIDEWAYS ──────────────────────────────────────────────────────
  // ALL three required: flat EMA20, flat EMA50, AND tight price range. The old
  // "EMA separation" check was too eager — it labelled trending pullbacks as
  // sideways. Trend Memory then provides a final escape: a strong recent move
  // overrides sideways even if the structural rule is met.
  const strictSideways = isStrictSideways(ema20Arr, ema50Arr, highs, lows, atr);

  if (strictSideways) {
    // Trend Memory: a strong recent impulse keeps the directional bias alive
    // even when EMAs have flattened. Prevents false SIDEWAYS during pullbacks.
    if (momentumBias === "BULLISH") return { direction: "BULLISH", strength: "WEAK", ...swings };
    if (momentumBias === "BEARISH") return { direction: "BEARISH", strength: "WEAK", ...swings };
    return { direction: "SIDEWAYS", strength: "RANGE", ...swings };
  }

  // Not strict sideways → market is TRENDING. Pick a direction.
  if (isBull) {
    const strength: "STRONG" | "WEAK" = (HH && HL) ? "STRONG" : "WEAK";
    return { direction: "BULLISH", strength, ...swings };
  }
  if (isBear) {
    const strength: "STRONG" | "WEAK" = (LL && LH) ? "STRONG" : "WEAK";
    return { direction: "BEARISH", strength, ...swings };
  }

  // EMAs equal — fall back to structure / momentum
  if (HH && HL) return { direction: "BULLISH", strength: "WEAK", ...swings };
  if (LL && LH) return { direction: "BEARISH", strength: "WEAK", ...swings };
  if (momentumBias === "BULLISH") return { direction: "BULLISH", strength: "WEAK", ...swings };
  if (momentumBias === "BEARISH") return { direction: "BEARISH", strength: "WEAK", ...swings };

  // Fully ambiguous → SIDEWAYS RANGE (rare in practice if not strictSideways)
  return { direction: "SIDEWAYS", strength: "RANGE", ...swings };
}

function calcIndicators(ohlc: OHLCData, prev: PrevState | null): ExtendedIndicators {
  const closes = cleanArray(ohlc.close);
  const highs  = cleanArray(ohlc.high);
  const lows   = cleanArray(ohlc.low);
  const opens  = cleanArray(ohlc.open);
  const vols   = (ohlc.volume ?? []).map(v => (typeof v === "number" && v > 0 ? v : 0));

  const rsi = calcRSI(closes, 14);

  // Gold-optimised trend: EMA20 (fast) / EMA50 (major)
  const ema20arr = calcEMA(closes, 20);
  const ema50arr = calcEMA(closes, 50);
  const ema20 = ema20arr[ema20arr.length - 1] ?? closes[closes.length - 1];
  const ema50 = ema50arr[ema50arr.length - 1] ?? closes[closes.length - 1];

  // MACD (12, 26, 9)
  const ema12arr = calcEMA(closes, 12);
  const ema26arr = calcEMA(closes, 26);
  const macdHistory: number[] = [];
  const macdLen = Math.min(ema12arr.length, ema26arr.length);
  for (let i = 0; i < macdLen; i++) macdHistory.push(ema12arr[i] - ema26arr[i]);
  const macdSignalArr = calcEMA(macdHistory, 9);
  const macdLine    = (ema12arr[ema12arr.length - 1] ?? 0) - (ema26arr[ema26arr.length - 1] ?? 0);
  const macdSignal  = macdSignalArr[macdSignalArr.length - 1] ?? 0;
  const macdHistogram = macdLine - macdSignal;

  const prevMacdHistogram = prev?.macdHistogram ?? macdHistogram;
  const atr     = calcATR(highs, lows, closes, 14);
  const prevAtr = prev?.atr ?? atr;

  // Price action bias (last 5 candles)
  const priceActionBias = getPriceActionBias(highs, lows, 5);

  // Entry confirmation
  const last = closes.length - 1;
  const lastClose      = closes[last];
  const lastOpen       = opens[last];
  const lastHigh       = highs[last];
  const lastLow        = lows[last];
  const prevHigh       = highs[last - 1] ?? highs[last];
  const prevLow        = lows[last - 1]  ?? lows[last];
  const lastCandleBullish = lastClose > lastOpen;
  const breaksPrevHigh    = lastClose > prevHigh;
  const breaksPrevLow     = lastClose < prevLow;

  // ── Structure: swing high/low EXCLUDING the current (developing) candle ──
  const lookbackStart = Math.max(0, last - STRUCTURE_LOOKBACK);
  const lookbackHighs = highs.slice(lookbackStart, last);
  const lookbackLows  = lows.slice(lookbackStart, last).filter(l => l > 0);
  const resistance = lookbackHighs.length ? Math.max(...lookbackHighs) : lastHigh;
  const support    = lookbackLows.length  ? Math.min(...lookbackLows)  : lastLow;

  const body      = Math.abs(lastOpen - lastClose);
  const upperWick = lastHigh - Math.max(lastOpen, lastClose);
  const lowerWick = Math.min(lastOpen, lastClose) - lastLow;
  const wickRatio = Math.max(upperWick, lowerWick) / Math.max(body, 1e-6);

  const trap = detectTrap(lastOpen, lastHigh, lastLow, lastClose, resistance, support, atr, lastClose);

  // ── Momentum exhaustion: last N candles all small body + long wicks ───────
  let exhausted = false;
  if (last >= EXHAUSTION_LOOKBACK) {
    let small = 0;
    for (let i = last - EXHAUSTION_LOOKBACK + 1; i <= last; i++) {
      const o = opens[i], c = closes[i], h = highs[i], l = lows[i];
      if (!(o > 0 && c > 0 && h > 0 && l > 0)) continue;
      const b = Math.abs(o - c);
      const uw = h - Math.max(o, c);
      const lw = Math.min(o, c) - l;
      const wick = Math.max(uw, lw);
      const isSmall   = b < lastClose * EXHAUSTION_BODY_PCT;
      const longWick  = wick >= b * EXHAUSTION_WICK_TO_BODY;
      if (isSmall && longWick) small++;
    }
    exhausted = small >= EXHAUSTION_LOOKBACK;
  }

  // ── Reversal watch: prior candle was a strong impulse, current shows
  //    rejection (long wick on the impulse side closing back) ───────────────
  let reversalWatchSide: "BULLISH" | "BEARISH" | null = null;
  if (last >= 1) {
    const pO = opens[last - 1], pC = closes[last - 1];
    const pBody = Math.abs(pO - pC);
    const wasStrongImpulse = pBody >= lastClose * REVERSAL_IMPULSE_BODY_PCT;
    if (wasStrongImpulse) {
      const bullishImpulse = pC > pO;
      const upperRejection = upperWick >= body * MIN_WICK_TO_BODY && upperWick > 0;
      const lowerRejection = lowerWick >= body * MIN_WICK_TO_BODY && lowerWick > 0;
      // Bullish impulse + upper rejection → watch for SELL reversal
      if (bullishImpulse && upperRejection)  reversalWatchSide = "BULLISH";
      // Bearish impulse + lower rejection → watch for BUY reversal
      if (!bullishImpulse && lowerRejection) reversalWatchSide = "BEARISH";
    }
  }

  const marketState: "TRENDING" | "EXHAUSTED" | "REVERSAL_WATCH" =
    exhausted             ? "EXHAUSTED"      :
    reversalWatchSide     ? "REVERSAL_WATCH" :
                            "TRENDING";

  // ── Trend Memory — momentum bias from last 5–10 candles ──────────────────
  const momentum = calcMomentum(closes, atr);

  // ── Smart Trend Engine — EMA + structure (HH/HL/LH/LL) + momentum memory ─
  const smart = classifySmartTrend(ema20arr, ema50arr, lastClose, highs, lows, atr, momentum.bias);

  // ── Pullback State — based on EMA20 / EMA50 position relative to price.
  // Independent of zoneStatus. Says "we're inside an active pullback in a
  // confirmed trend" — used by MTF "SETUP FORMING" detection.
  let pullbackState: "BULLISH_PULLBACK" | "BEARISH_PULLBACK" | "NONE" = "NONE";
  if (smart.direction === "BULLISH" && lastClose < ema20 && lastClose > ema50) {
    pullbackState = "BULLISH_PULLBACK";
  } else if (smart.direction === "BEARISH" && lastClose > ema20 && lastClose < ema50) {
    pullbackState = "BEARISH_PULLBACK";
  }

  // ── Pullback Entry Engine — zone + rejection candle ──────────────────────
  // Zone width = ATR*0.5, clamped to 3..6 points (gold pip scale).
  const pullbackRange = Math.min(6, Math.max(3, atr * 0.5));

  // Expanded zone activation — fires if EITHER price is near EMA20 OR price
  // has retraced 30–50 % of the most recent confirmed swing leg. Direction is
  // inferred from the smart trend; both STRONG and WEAK qualify so the UI can
  // display zone status during full-strength trend pullbacks too.
  let zoneStatus: "BUY_ZONE" | "SELL_ZONE" | "NO_ZONE" = "NO_ZONE";
  if (smart.direction === "BULLISH") {
    const z = inExpandedPullbackZone("BUY", lastClose, ema20, atr,
      smart.swingHigh1, smart.swingLow1, pullbackRange);
    if (z.active) zoneStatus = "BUY_ZONE";
  } else if (smart.direction === "BEARISH") {
    const z = inExpandedPullbackZone("SELL", lastClose, ema20, atr,
      smart.swingHigh1, smart.swingLow1, pullbackRange);
    if (z.active) zoneStatus = "SELL_ZONE";
  }

  // Rejection candle: requires a real body (skip dojis) and matching wick/close.
  const meaningfulBody = body >= lastClose * MIN_BODY_PCT;
  const buyRejection  = lowerWick >= body * MIN_WICK_TO_BODY && lastCandleBullish && meaningfulBody;
  const sellRejection = upperWick >= body * MIN_WICK_TO_BODY && !lastCandleBullish && meaningfulBody;
  let pullbackConfirmation: "WAITING" | "REJECTION_DETECTED" = "WAITING";
  if (zoneStatus === "BUY_ZONE"  && buyRejection)  pullbackConfirmation = "REJECTION_DETECTED";
  if (zoneStatus === "SELL_ZONE" && sellRejection) pullbackConfirmation = "REJECTION_DETECTED";

  // ── Volume spike detection (NEW) ──────────────────────────────────────────
  // Yahoo intraday volume is sometimes 0 for futures — fall back gracefully.
  const volSlice = vols.slice(Math.max(0, last - 20), last); // prior 20 bars
  const volNon0  = volSlice.filter(v => v > 0);
  const volumeAvg  = volNon0.length ? volNon0.reduce((a, b) => a + b, 0) / volNon0.length : 0;
  const volumeLast = vols[last] ?? 0;
  const volumeSpike = volumeAvg > 0 && volumeLast > volumeAvg * 1.5;

  // ── Strong breakout detection (NEW) ──────────────────────────────────────
  // BUY: closes above the prior swing high with a wide bullish body and
  // either a volume spike OR (volume missing) a particularly wide range.
  // SELL is the mirror. Used by the score engine as a pullback fallback.
  const wideBody     = body >= lastClose * 0.0008;   // body ≥ 0.08% of price
  const veryWideBody = body >= lastClose * 0.0012;   // 0.12% — used when no vol
  const breaksRes    = lastClose > smart.swingHigh1 || breaksPrevHigh;
  const breaksSup    = lastClose < smart.swingLow1  || breaksPrevLow;
  const strongBreakoutBuy  = breaksRes && lastCandleBullish && wideBody  && (volumeSpike || veryWideBody);
  const strongBreakoutSell = breaksSup && !lastCandleBullish && wideBody && (volumeSpike || veryWideBody);

  return {
    rsi, ema20, ema50,
    macdLine, macdSignal, macdHistogram,
    atr, prevMacdHistogram, prevAtr,
    priceActionBias, lastCandleBullish, breaksPrevHigh, breaksPrevLow,
    resistance, support, upperWick, lowerWick, body, wickRatio, trap,
    exhausted, reversalWatchSide, marketState,
    trendDirection: smart.direction,
    trendStrength:  smart.strength,
    swingHigh1:     smart.swingHigh1,
    swingHigh2:     smart.swingHigh2,
    swingLow1:      smart.swingLow1,
    swingLow2:      smart.swingLow2,
    pullbackRange,
    zoneStatus,
    pullbackConfirmation,
    pullbackState,
    momentumBias:   momentum.bias,
    momentumScore:  momentum.score,
    volumeAvg,
    volumeLast,
    volumeSpike,
    strongBreakoutBuy,
    strongBreakoutSell,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeHold(
  price: number,
  atr: number,
  trend: "BULLISH" | "BEARISH" | "NEUTRAL",
  marketMode: "TRENDING" | "SIDEWAYS",
  timeframe: string,
  indicators: ExtendedIndicators,
  confidence: number
): Omit<SignalResult, "timestamp"> {
  return {
    signal: "HOLD",
    confidence: Math.min(45, Math.max(10, Math.round(confidence))),
    entry: parseFloat(price.toFixed(2)),
    stopLoss: parseFloat((price - atr * 0.8).toFixed(2)),
    takeProfit: parseFloat((price + atr * 1.2).toFixed(2)),
    trend,
    trendStrength: indicators.trendStrength,
    marketMode,
    timeframe,
    indicators,
  };
}

// ── Risk / Reward Engine ───────────────────────────────────────────────────────
// Single source of truth for SL/TP/TP1/TP2 across every directional signal.
//   SL  = entry ± ATR × SL_ATR_MULT          (risk in price units)
//   TP1 = entry ± risk × TP1_R_MULT          (partial profit ~1.2R)
//   TP2 = entry ± risk × TP2_R_MULT          (final target  ~2.2R)
//   takeProfit mirrors TP2 for backward compatibility.
const SL_ATR_MULT = 1.0;
const TP1_R_MULT  = 1.2;
const TP2_R_MULT  = 2.2;

function computeRiskTargets(entry: number, atr: number, side: "BUY" | "SELL") {
  const risk = Math.max(atr * SL_ATR_MULT, 0.01); // never zero
  const sign = side === "BUY" ? 1 : -1;
  const stopLoss   = entry - sign * risk;
  const tp1        = entry + sign * risk * TP1_R_MULT;
  const tp2        = entry + sign * risk * TP2_R_MULT;
  return {
    stopLoss:   parseFloat(stopLoss.toFixed(2)),
    takeProfit: parseFloat(tp2.toFixed(2)),
    tp1:        parseFloat(tp1.toFixed(2)),
    tp2:        parseFloat(tp2.toFixed(2)),
  };
}

function makeSell(
  price: number, atr: number, confidence: number,
  marketMode: "TRENDING" | "SIDEWAYS", timeframe: string,
  indicators: ExtendedIndicators, signalLabel: string
): Omit<SignalResult, "timestamp"> {
  const targets = computeRiskTargets(price, atr, "SELL");
  return {
    signal: "SELL",
    confidence: Math.min(95, Math.round(confidence)),
    entry: parseFloat(price.toFixed(2)),
    ...targets,
    trend: "BEARISH",
    trendStrength: indicators.trendStrength,
    marketMode,
    signalLabel,
    timeframe,
    indicators,
  };
}

function makeBuy(
  price: number, atr: number, confidence: number,
  marketMode: "TRENDING" | "SIDEWAYS", timeframe: string,
  indicators: ExtendedIndicators, signalLabel: string
): Omit<SignalResult, "timestamp"> {
  const targets = computeRiskTargets(price, atr, "BUY");
  return {
    signal: "BUY",
    confidence: Math.min(95, Math.round(confidence)),
    entry: parseFloat(price.toFixed(2)),
    ...targets,
    trend: "BULLISH",
    trendStrength: indicators.trendStrength,
    marketMode,
    signalLabel,
    timeframe,
    indicators,
  };
}

// ── Pullback Entry Engine ──────────────────────────────────────────────────────
// Fires only on WEAK trend states with price inside the EMA20 zone, after a
// rejection candle prints, and inside a tight RSI window. Builds a signal with
// swing-based stop and 2× ATR target (R:R ≈ 2:1).
function tryPullbackEntry(
  ind: ExtendedIndicators,
  currentPrice: number,
  marketMode: "TRENDING" | "SIDEWAYS",
  timeframe: string,
  side: "BUY" | "SELL",
): Omit<SignalResult, "timestamp"> | null {
  const { zoneStatus, pullbackConfirmation, rsi, atr, lastCandleBullish } = ind;

  // Hard gates per spec
  if (side === "BUY") {
    if (zoneStatus !== "BUY_ZONE") return null;
    if (pullbackConfirmation !== "REJECTION_DETECTED") return null;
    if (rsi < 40 || rsi > 55) return null;
    if (!lastCandleBullish) return null;
  } else {
    if (zoneStatus !== "SELL_ZONE") return null;
    if (pullbackConfirmation !== "REJECTION_DETECTED") return null;
    if (rsi < 45 || rsi > 60) return null;
    if (lastCandleBullish) return null;
  }

  const entry = currentPrice;
  // Use the unified Risk/Reward Engine — fixed ATR×1.0 stop, 2.2R final target,
  // 1.2R partial target. Keeps every directional signal on the same R:R model.
  const targets = computeRiskTargets(entry, atr, side);

  // Confidence: base 70 (above the 65 floor) + small bonuses for clean setup.
  let conf = 70;
  // Sweet-spot RSI in middle of the window earns a small bonus.
  const sweet = side === "BUY" ? 47.5 : 52.5;
  conf += Math.max(0, 5 - Math.abs(rsi - sweet));
  // Tight zone (price hugging EMA20) earns a small bonus.
  const distFromEma20 = Math.abs(entry - ind.ema20);
  if (distFromEma20 <= ind.pullbackRange * 0.5) conf += 3;

  return {
    signal: side,
    confidence: Math.min(95, Math.round(conf)),
    entry: parseFloat(entry.toFixed(2)),
    ...targets,
    trend: side === "BUY" ? "BULLISH" : "BEARISH",
    trendStrength: ind.trendStrength,
    marketMode,
    signalLabel: side === "BUY" ? "BUY_PULLBACK" : "SELL_PULLBACK",
    timeframe,
    indicators: ind,
    zoneStatus,
    pullbackConfirmation,
  };
}

// ── Signal Engine ──────────────────────────────────────────────────────────────
function generateSignal(
  indicators: ExtendedIndicators,
  currentPrice: number,
  timeframe: string,
): Omit<SignalResult, "timestamp"> {
  const {
    rsi, ema20, ema50, macdLine, macdSignal, macdHistogram,
    atr, prevMacdHistogram, prevAtr,
    priceActionBias, lastCandleBullish, breaksPrevHigh, breaksPrevLow,
    trap, trendDirection, trendStrength,
  } = indicators;

  // ── 1. ATR Volatility Filter ─────────────────────────────────────────────
  const atrPct = atr / currentPrice;
  if (atrPct < 0.0006) {
    return makeHold(currentPrice, atr, "NEUTRAL", "TRENDING", timeframe, indicators, 20);
  }
  if (atrPct > 0.007) {
    return makeHold(currentPrice, atr, "NEUTRAL", "TRENDING", timeframe, indicators, 15);
  }

  const atrRising = prevAtr > 0 && atr > prevAtr * 1.02;

  // ── 2. Market Mode Detection ─────────────────────────────────────────────
  // Strict sideways: require ALL of flat EMA20, flat EMA50, AND tight range.
  // The Smart Trend Engine already applied this rule when classifying the
  // trend, so reuse its output to keep both layers consistent. Trend Memory
  // (momentumBias) takes precedence — if there's a strong recent move,
  // marketMode stays TRENDING even if EMAs look flat.
  const marketMode: "TRENDING" | "SIDEWAYS" =
    trendDirection === "SIDEWAYS" ? "SIDEWAYS" : "TRENDING";

  // ── 2.5 TRAP / STOP HUNT (HIGHEST PRIORITY) ──────────────────────────────
  // Liquidity grabs and fake breakouts override normal indicator logic — they
  // catch the reversal AFTER smart money has hunted stops, which has the best
  // risk/reward in scalping. The 2-candle confirmation in applyFilters still
  // gates the trade, so a single noisy wick won't fire.
  if (trap) {
    const isSell = trap === "FAKE_BREAKOUT_SELL" || trap === "STOP_HUNT_SELL";
    const isBull  = ema20 > ema50;
    const isBear  = ema20 < ema50;
    const trendAligned = (isSell && isBear) || (!isSell && isBull);
    let conf = 65 + 25;                       // base + trap boost
    if (trendAligned)            conf += 10; // align bonus → +35 total
    if (indicators.wickRatio > 2.5) conf += 3;
    if (atrRising)               conf += 2;
    const label =
      trap === "FAKE_BREAKOUT_SELL" ? "FAKE BREAKOUT SELL" :
      trap === "FAKE_BREAKDOWN_BUY" ? "FAKE BREAKDOWN BUY" :
      trap === "STOP_HUNT_SELL"     ? "STOP HUNT SELL"     :
                                       "STOP HUNT BUY";
    return isSell
      ? makeSell(currentPrice, atr, conf, marketMode, timeframe, indicators, label)
      : makeBuy(currentPrice,  atr, conf, marketMode, timeframe, indicators, label);
  }

  // ── 4. SIDEWAYS Logic ────────────────────────────────────────────────────
  // Primary: RSI extremes (high confidence reversal)
  // Secondary: MACD cross (lower confidence momentum signal)
  if (marketMode === "SIDEWAYS") {
    // SIDEWAYS = noisy market. Only allow RSI extreme scalps. No MACD-only entries.
    const macdBearish = macdLine < macdSignal || macdHistogram < 0;
    const macdBullish = macdLine > macdSignal || macdHistogram > 0;

    // RSI oversold — RSI-based reversal BUY
    if (rsi < 30) {
      let conf = Math.min(84, 60 + Math.round((30 - rsi) * 2));
      if (lastCandleBullish) conf += 6;
      if (macdBullish)       conf += 4;
      return makeBuy(currentPrice, atr, conf, marketMode, timeframe, indicators, "SIDEWAYS RSI BUY");
    }

    // RSI overbought — RSI-based reversal SELL
    if (rsi > 70) {
      let conf = Math.min(84, 60 + Math.round((rsi - 70) * 2));
      if (!lastCandleBullish) conf += 6;
      if (macdBearish)        conf += 4;
      return makeSell(currentPrice, atr, conf, marketMode, timeframe, indicators, "SIDEWAYS RSI SELL");
    }

    return makeHold(currentPrice, atr, "NEUTRAL", marketMode, timeframe, indicators, 28);
  }

  // ── 5. SMART TREND ENGINE — EMA + Structure (HH/HL/LH/LL) ────────────────
  // Replaces the simple "EMA20 vs EMA50" classifier. trendDirection comes from
  // classifySmartTrend which combines EMA bias with confirmed swing structure.
  const isBullishTrend = trendDirection === "BULLISH";
  const isBearishTrend = trendDirection === "BEARISH";
  const isSidewaysTrend = trendDirection === "SIDEWAYS";

  // MACD direction — RSI no longer blocks SELL in a bearish trend
  const macdBearish = macdLine < macdSignal || macdHistogram < 0;
  const macdBullish = macdLine > macdSignal || macdHistogram > 0;
  const macdBearCross = macdHistogram < 0 && prevMacdHistogram >= 0; // fresh bearish cross
  const macdBullCross = macdHistogram > 0 && prevMacdHistogram <= 0; // fresh bullish cross

  // Pullback detection (price retracing to EMA20 = better entry)
  const nearEma20 = Math.abs(currentPrice - ema20) / currentPrice < 0.0015;
  const pullbackSell = isBearishTrend && nearEma20 && !lastCandleBullish;
  const pullbackBuy  = isBullishTrend && nearEma20 &&  lastCandleBullish;

  // Smart Trend strength → confidence adjustment.
  //   STRONG → +20  |  WEAK → -10  |  RANGE → -25
  const strengthDelta = (() => {
    if (isSidewaysTrend) return -25;
    return trendStrength === "STRONG" ? 20 : -10;
  })();

  // SIDEWAYS — early-out, only RSI extremes already handled above. Anything
  // that fell through to here in a sideways tape stays HOLD.
  if (isSidewaysTrend) {
    return makeHold(currentPrice, atr, "NEUTRAL", marketMode, timeframe, indicators, 25 + strengthDelta);
  }

  // ── 6. BEARISH TREND LOGIC ───────────────────────────────────────────────
  if (isBearishTrend) {

    // ── WEAK bearish: ONLY the Pullback Entry Engine can fire a SELL.
    //    No more random "near EMA20" entries — require zone + rejection + RSI.
    if (trendStrength === "WEAK") {
      const pb = tryPullbackEntry(indicators, currentPrice, marketMode, timeframe, "SELL");
      if (pb) return pb;
      // WEAK + no confirmed pullback → HOLD (do not chase).
      return makeHold(currentPrice, atr, "BEARISH", marketMode, timeframe, indicators, 32 + strengthDelta);
    }

    // ── STRONG bearish: existing trend-following logic ───────────────────
    if (macdBearish) {
      let conf = 62 + strengthDelta;                      // STRONG +20
      if (!lastCandleBullish && breaksPrevLow) conf += 12;
      else if (!lastCandleBullish)             conf += 5;
      if (pullbackSell)  conf += 15;
      if (macdBearCross) conf += 10;
      if (atrRising)     conf += 5;
      if (priceActionBias === "BEARISH") conf += 5;
      const label = pullbackSell ? "PULLBACK SELL" : "TREND FOLLOWING SELL";
      return makeSell(currentPrice, atr, conf, marketMode, timeframe, indicators, label);
    }

    // ── COUNTER-TREND REVERSAL BUY — needs strong reversal signal ────────
    const macdTurningBullish = macdBullCross || (prevMacdHistogram < 0 && macdHistogram > prevMacdHistogram * 0.5);
    if (rsi < 30 && macdTurningBullish) {
      let conf = 55;
      conf += Math.round((30 - rsi) * 1.5);
      if (lastCandleBullish && breaksPrevHigh) conf += 12;
      else if (lastCandleBullish)              conf += 5;
      if (macdBullCross) conf += 10;
      return makeBuy(currentPrice, atr, Math.min(78, conf), marketMode, timeframe, indicators, "REVERSAL BUY");
    }

    // WEAK bearish + no pullback OR no MACD = HOLD (do not chase)
    return makeHold(currentPrice, atr, "BEARISH", marketMode, timeframe, indicators, 32 + strengthDelta);
  }

  // ── 7. BULLISH TREND LOGIC ───────────────────────────────────────────────
  if (isBullishTrend) {

    // ── WEAK bullish: ONLY the Pullback Entry Engine can fire a BUY.
    if (trendStrength === "WEAK") {
      const pb = tryPullbackEntry(indicators, currentPrice, marketMode, timeframe, "BUY");
      if (pb) return pb;
      return makeHold(currentPrice, atr, "BULLISH", marketMode, timeframe, indicators, 32 + strengthDelta);
    }

    // ── STRONG bullish: existing trend-following logic ───────────────────
    if (macdBullish) {
      let conf = 62 + strengthDelta;
      if (lastCandleBullish && breaksPrevHigh) conf += 12;
      else if (lastCandleBullish)              conf += 5;
      if (pullbackBuy)   conf += 15;
      if (macdBullCross) conf += 10;
      if (atrRising)     conf += 5;
      if (priceActionBias === "BULLISH") conf += 5;
      const label = pullbackBuy ? "PULLBACK BUY" : "TREND FOLLOWING BUY";
      return makeBuy(currentPrice, atr, conf, marketMode, timeframe, indicators, label);
    }

    // ── COUNTER-TREND SELL (bearish reversal in bullish trend) ───────────
    if (rsi > 70 && (macdBearCross || macdHistogram < 0)) {
      let conf = 55;
      conf += Math.round((rsi - 70) * 1.5);
      if (!lastCandleBullish && breaksPrevLow) conf += 12;
      else if (!lastCandleBullish)             conf += 5;
      if (macdBearCross) conf += 10;
      return makeSell(currentPrice, atr, Math.min(78, conf), marketMode, timeframe, indicators, "REVERSAL SELL");
    }

    return makeHold(currentPrice, atr, "BULLISH", marketMode, timeframe, indicators, 32 + strengthDelta);
  }

  // ── 8. No clear trend ────────────────────────────────────────────────────
  return makeHold(currentPrice, atr, "NEUTRAL", marketMode, timeframe, indicators, 20);
}

// ── Signal Type Classification ─────────────────────────────────────────────────
function classifySignalType(label?: string): "TREND" | "REVERSAL" {
  if (!label) return "TREND";
  if (label.includes("REVERSAL") || label.includes("SIDEWAYS")) return "REVERSAL";
  return "TREND";
}

// ── Reversal Strength Validation ───────────────────────────────────────────────
// When flipping direction vs the last confirmed signal, require all three:
//   • RSI extreme  (< 30 for BUY reversal,  > 70 for SELL reversal)
//   • Fresh MACD crossover in the new direction
//   • Candle confirmation in the new direction
function isStrongReversal(
  newSignal: "BUY" | "SELL",
  ind: ExtendedIndicators
): boolean {
  const macdBullCross = ind.macdHistogram > 0 && ind.prevMacdHistogram <= 0;
  const macdBearCross = ind.macdHistogram < 0 && ind.prevMacdHistogram >= 0;
  if (newSignal === "BUY") {
    return ind.rsi < 30 && macdBullCross && ind.lastCandleBullish;
  }
  return ind.rsi > 70 && macdBearCross && !ind.lastCandleBullish;
}

// ── Indicator Conflict Engine ─────────────────────────────────────────────────
// Each indicator has ONE job (per spec):
//   EMA       → trend filter
//   MACD      → momentum confirmation
//   RSI       → timing condition
//   Trend Mem → recent directional memory (8-candle bias)
//   HTF (15m) → higher-timeframe trend
//   Structure → HH/HL vs LL/LH market structure
// We collect each indicator's vote then count agreement. The output drives:
//   permission gating, the bannerMessage, and the CONFLICT signal state.
export function computeIndicatorBias(ind: ExtendedIndicators, htf: HigherTrend): IndicatorBias {
  const ema: IndicatorVote =
    ind.ema20 > ind.ema50 * 1.0002 ? "BULLISH" :
    ind.ema20 < ind.ema50 * 0.9998 ? "BEARISH" : "NEUTRAL";

  // MACD: only count it as bullish/bearish when BOTH line-vs-signal AND
  // histogram agree. Otherwise it's mixed → NEUTRAL (avoids double-counting
  // weak / near-zero histograms).
  const macd: IndicatorVote =
    (ind.macdLine > ind.macdSignal && ind.macdHistogram > 0) ? "BULLISH" :
    (ind.macdLine < ind.macdSignal && ind.macdHistogram < 0) ? "BEARISH" : "NEUTRAL";

  // RSI as timing only — extreme zones speak strongly, the middle stays neutral.
  const rsi: IndicatorVote =
    ind.rsi > 55 ? "BULLISH" :
    ind.rsi < 45 ? "BEARISH" : "NEUTRAL";

  const momentum: IndicatorVote =
    ind.momentumBias === "BULLISH" ? "BULLISH" :
    ind.momentumBias === "BEARISH" ? "BEARISH" : "NEUTRAL";

  const htfVote: IndicatorVote =
    htf === "BULLISH" ? "BULLISH" :
    htf === "BEARISH" ? "BEARISH" : "NEUTRAL";

  // Structure: the Smart Trend output already encodes HH/HL vs LL/LH.
  const structure: IndicatorVote =
    ind.trendDirection === "BULLISH" ? "BULLISH" :
    ind.trendDirection === "BEARISH" ? "BEARISH" : "NEUTRAL";

  return { ema, macd, rsi, momentum, htf: htfVote, structure };
}

export function detectIndicatorConflict(bias: IndicatorBias):
  { level: "NONE" | "MINOR" | "MIXED" | "SEVERE"; reasons: string[] }
{
  const votes = [bias.ema, bias.macd, bias.rsi, bias.momentum, bias.htf, bias.structure];
  const bull    = votes.filter(v => v === "BULLISH").length;
  const bear    = votes.filter(v => v === "BEARISH").length;
  const neutral = votes.filter(v => v === "NEUTRAL").length;

  const reasons: string[] = [];
  // Direct EMA-vs-Memory disagreement is the classic "trap setup" tell.
  if (bias.ema === "BULLISH" && bias.momentum === "BEARISH") reasons.push("EMA bullish but trend memory bearish");
  if (bias.ema === "BEARISH" && bias.momentum === "BULLISH") reasons.push("EMA bearish but trend memory bullish");
  if (bias.ema === "BULLISH" && bias.macd === "BEARISH")     reasons.push("EMA bullish but MACD bearish");
  if (bias.ema === "BEARISH" && bias.macd === "BULLISH")     reasons.push("EMA bearish but MACD bullish");
  if (bias.htf === "NEUTRAL")                                reasons.push("Higher TF (15m) is neutral");
  if (bias.structure === "NEUTRAL" && (bull >= 2 || bear >= 2)) {
    reasons.push("No confirmed market structure yet");
  }

  // Severity:
  //   SEVERE = 2+ on each side (real opposing votes), no clear winner
  //   MIXED  = both sides have at least one vote and the gap is ≤ 1
  //   MINOR  = clear leader but ≥ 1 dissent or HTF neutral
  //   NONE   = unanimous-ish (all in one direction or only neutrals)
  let level: "NONE" | "MINOR" | "MIXED" | "SEVERE" = "NONE";
  if (bull >= 2 && bear >= 2)                    level = "SEVERE";
  else if (bull >= 1 && bear >= 1 && Math.abs(bull - bear) <= 1) level = "MIXED";
  else if ((bull > 0 && bear > 0) || bias.htf === "NEUTRAL")     level = "MINOR";
  else if (neutral === votes.length)             level = "MINOR"; // entirely flat = mild caution

  return { level, reasons };
}

// ── Chop / Volatility Filter ──────────────────────────────────────────────────
// Returns 0..1 — higher = choppier. > 0.6 ≈ pure consolidation.
// Combines two signals:
//   1. Direction-change density: how often candles flip direction (last 14)
//   2. EMA20 / EMA50 oscillation: how many times EMA20 crosses EMA50 (last 20)
// A trending market has few direction flips and zero EMA crosses.
export function computeChopScore(
  closes: number[], opens: number[],
  ema20Arr: number[], ema50Arr: number[],
): number {
  const N = 14;
  if (closes.length < N + 1 || opens.length < N + 1) return 0;
  let flips = 0;
  for (let i = closes.length - N + 1; i < closes.length; i++) {
    const cur  = closes[i] >= opens[i] ? 1 : -1;
    const prev = closes[i - 1] >= opens[i - 1] ? 1 : -1;
    if (cur !== prev) flips++;
  }
  // Random walk sits ~7/14 flips; trending ~3-4. Normalise to 0..1.
  const flipScore = Math.min(1, Math.max(0, (flips - 4) / (N - 4)));

  let crosses = 0;
  const M = Math.min(20, ema20Arr.length, ema50Arr.length) - 1;
  for (let i = ema20Arr.length - M; i < ema20Arr.length; i++) {
    if (i <= 0) continue;
    const curUp  = ema20Arr[i]     > ema50Arr[i];
    const prevUp = ema20Arr[i - 1] > ema50Arr[i - 1];
    if (curUp !== prevUp) crosses++;
  }
  const crossScore = Math.min(1, crosses / 3); // 3 EMA flips in 20 bars = max chop

  // Weighted blend — flip density is the stronger signal.
  return parseFloat((flipScore * 0.65 + crossScore * 0.35).toFixed(3));
}

// ── Market Regime Engine ──────────────────────────────────────────────────────
// One label that summarises the playing field. Drives both the permission
// engine and the user-facing banner.
export function classifyMarketRegime(
  trendDirection: "BULLISH" | "BEARISH" | "SIDEWAYS",
  trendStrength:  "STRONG" | "WEAK" | "RANGE",
  chopScore:      number,
  conflictLevel:  "NONE" | "MINOR" | "MIXED" | "SEVERE",
): "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "CHOPPY" | "TRANSITION" {
  if (chopScore > 0.6 || conflictLevel === "SEVERE") return "CHOPPY";
  if (conflictLevel === "MIXED")                     return "TRANSITION";
  if (trendDirection === "BULLISH" && trendStrength !== "WEAK") return "TRENDING_BULL";
  if (trendDirection === "BEARISH" && trendStrength !== "WEAK") return "TRENDING_BEAR";
  if (trendDirection === "SIDEWAYS" || trendStrength === "RANGE") return "RANGING";
  // Weak trend + no severe conflict = transitional
  return "TRANSITION";
}

// ── Permission Engine — splits "I see a setup" from "you should trade it" ─────
// Rules (per spec):
//   • SEVERE conflict          → BLOCKED
//   • CHOPPY regime            → BLOCKED (no scalps in chop)
//   • signal already HOLD/CONFLICT → BLOCKED
//   • HTF NEUTRAL              → cap at QUALIFIED unless conf ≥ 80
//   • MIXED conflict           → cap at WATCHLIST (context only, no levels)
//   • confidence < 60          → WATCHLIST
//   • CONFIRMED + HTF aligned + conf ≥ 75 + no conflict → ACTIONABLE
//   • everything else passes  → QUALIFIED
export function derivePermission(
  signal:        SignalResult["signal"],
  signalStatus:  SignalResult["signalStatus"],
  confidence:    number,
  conflictLevel: "NONE" | "MINOR" | "MIXED" | "SEVERE",
  htf:           HigherTrend,
  regime:        SignalResult["marketRegime"],
  mtfStatus:     SignalResult["mtfStatus"],
): "ACTIONABLE" | "QUALIFIED" | "WATCHLIST" | "BLOCKED" {
  // Non-directional signals never get tradable permission.
  if (signal === "HOLD" || signal === "CONFLICT") return "BLOCKED";
  if (signal === "SETUP") return "WATCHLIST";

  // Per the score-engine refactor: no more hard BLOCKS on conflict / chop
  // / mtf CONTRA. Those conditions become quality DOWNGRADES (WATCHLIST or
  // QUALIFIED rather than BLOCKED), so weak setups still surface trade
  // levels but with context warnings.
  if (confidence < 30) return "WATCHLIST";

  // Severe conflict or choppy market — context-only, not a hard block.
  if (conflictLevel === "SEVERE") return "WATCHLIST";
  if (regime === "CHOPPY")        return "WATCHLIST";

  // CONTRA HTF (entry against 15m trend) — show levels but mark QUALIFIED
  // (never ACTIONABLE).
  const htfContra = mtfStatus === "BLOCKED" || mtfStatus === "CONTRA";

  // MIXED evidence — surface levels but cap at QUALIFIED.
  if (conflictLevel === "MIXED") {
    return confidence >= 50 ? "QUALIFIED" : "WATCHLIST";
  }

  // HTF supportive + confirmed + high conf = full permission.
  const htfSupportive = mtfStatus === "ALIGNED" || mtfStatus === "SUPPORTIVE";
  if (signalStatus === "CONFIRMED" && htfSupportive &&
      confidence >= 60 && conflictLevel === "NONE") {
    return "ACTIONABLE";
  }

  if (htfContra) return "QUALIFIED";

  return "QUALIFIED";
}

// ── UI Decision Engine — soften aggressive labels + build banner ──────────────
export function buildBannerMessage(
  permission:    "ACTIONABLE" | "QUALIFIED" | "WATCHLIST" | "BLOCKED",
  conflictLevel: "NONE" | "MINOR" | "MIXED" | "SEVERE",
  regime:        SignalResult["marketRegime"],
  htf:           HigherTrend,
): string | undefined {
  if (regime === "CHOPPY")          return "Choppy market — no scalp setups";
  if (conflictLevel === "SEVERE")   return "Conflict / Transition — indicators disagree, stand aside";
  if (conflictLevel === "MIXED")    return "Mixed indicators — waiting for structure confirmation";
  if (permission === "WATCHLIST")   return "Watchlist only — context not yet tradable";
  if (htf === "NEUTRAL" && permission === "QUALIFIED") return "Higher TF neutral — caution";
  return undefined;
}

export function softenSignalLabel(
  signalLabel: string | undefined,
  signal:      SignalResult["signal"],
  permission:  "ACTIONABLE" | "QUALIFIED" | "WATCHLIST" | "BLOCKED",
  bias:        IndicatorBias,
): string | undefined {
  if (!signalLabel) return signalLabel;
  // Score-engine labels (e.g. "STRONG BUY · PULLBACK · HTF SUPPORTIVE") are
  // already descriptive — keep them as-is regardless of permission.
  if (/^(STRONG|NORMAL|WEAK)\s+(BUY|SELL)\s+·/.test(signalLabel)) return signalLabel;
  // Only soften when permission is below tradable. ACTIONABLE / QUALIFIED keep
  // the original engine label.
  if (permission === "ACTIONABLE" || permission === "QUALIFIED") return signalLabel;

  // For WATCHLIST / BLOCKED, replace strong labels with descriptive ones.
  if (signal === "BUY")   return bias.macd === "BULLISH" ? "Candidate buy area · mild bullish momentum"
                                                          : "Candidate buy area · weak momentum";
  if (signal === "SELL")  return bias.macd === "BEARISH" ? "Candidate sell area · weak bearish MACD"
                                                          : "Candidate sell area · weak momentum";
  if (signal === "SETUP") return "Setup forming · waiting for confirmation";
  if (signal === "CONFLICT") return "Conflict / Transition";
  // HOLD: describe the trend context softly
  if (bias.ema === "BULLISH") return "Bullish trend context · no entry";
  if (bias.ema === "BEARISH") return "Bearish trend context · no entry";
  return "Neutral context · no entry";
}

// ── Multi-Timeframe Confirmation ──────────────────────────────────────────────
// Status rules (per spec):
//   • signal == HOLD                       → mtfStatus = "WAITING"
//   • BUY+BULLISH or SELL+BEARISH          → mtfStatus = "ALIGNED"   (+20 conf)
//   • directional but mismatched           → mtfStatus = "BLOCKED"   (HOLD unless trap/reversal escape)
//
// Special states added on top:
//   • SETUP — 15m trend known, raw is HOLD with conf 40-59 → "trade forming"
//   • Early Trend Entry — raw is HOLD AND 15m trend known AND raw conf ≥ 60
//     → promote to BUY/SELL with entryQuality="EARLY" so we don't miss strong moves
//   • entryQuality: confidence ≥ 65 → "CONFIRMED", 60-64 → "EARLY"
function applyMtfConfirmation(
  raw: Omit<SignalResult, "timestamp">,
  higherTrend: HigherTrend,
  timeframe: string,
  indicators: ExtendedIndicators,
): Omit<SignalResult, "timestamp"> {
  // 15m feed itself just gets the trend tag for UI; no MTF rules applied.
  if (timeframe === "15m") {
    return { ...raw, higherTrend, mtfStatus: "WAITING" };
  }

  const trendKnown = higherTrend === "BULLISH" || higherTrend === "BEARISH";
  const trendDir: "BUY" | "SELL" | null =
    higherTrend === "BULLISH" ? "BUY" :
    higherTrend === "BEARISH" ? "SELL" : null;

  // ── SETUP FORMING: higher TF trending + lower TF in matching pullback ────
  // The entry TF hasn't fired yet (still HOLD or SETUP), but the pullback
  // state on the entry TF lines up with the higher-TF direction → flag the
  // setup so the user knows a trade is brewing, not that the market is dead.
  const lowerInBullPullback = indicators.pullbackState === "BULLISH_PULLBACK";
  const lowerInBearPullback = indicators.pullbackState === "BEARISH_PULLBACK";
  const setupFormingDir: "BUY" | "SELL" | null =
    higherTrend === "BULLISH" && lowerInBullPullback ? "BUY"  :
    higherTrend === "BEARISH" && lowerInBearPullback ? "SELL" : null;

  if (setupFormingDir && (raw.signal === "HOLD" || raw.signal === "SETUP")) {
    return {
      ...raw,
      signal: "SETUP",
      higherTrend,
      mtfStatus: "SETUP_FORMING",
      signalLabel: `SETUP FORMING — ${higherTrend} pullback on ${timeframe}`,
    };
  }

  // ── Early Trend Entry: raw HOLD + clear trend + conf ≥ 60 → directional ──
  // Catches strong trending moves before the entry TF fully aligns.
  if (raw.signal === "HOLD" && trendDir && raw.confidence >= 60) {
    const conf = raw.confidence;
    return {
      ...raw,
      signal: trendDir,
      higherTrend,
      mtfStatus: "ALIGNED",
      entryQuality: conf >= 65 ? "CONFIRMED" : "EARLY",
      signalLabel: `EARLY ${trendDir} (${higherTrend} TREND)`,
    };
  }

  // ── SETUP: trend clear, raw still HOLD with moderate conf 40-59 ───────────
  if (raw.signal === "HOLD" && trendDir && raw.confidence >= 40) {
    return {
      ...raw,
      signal: "SETUP",
      higherTrend,
      mtfStatus: "WAITING",
      signalLabel: `SETUP — preparing ${trendDir}`,
    };
  }

  // ── Plain HOLD (no trend, or low confidence) ──────────────────────────────
  if (raw.signal === "HOLD") {
    return { ...raw, higherTrend, mtfStatus: "WAITING" };
  }

  // ── Directional signal with NEUTRAL higher TF → pass through ──────────────
  if (!trendKnown) {
    return {
      ...raw,
      higherTrend,
      mtfStatus: "WAITING",
      entryQuality: raw.confidence >= 65 ? "CONFIRMED" : "EARLY",
    };
  }

  // ── Aligned: BUY+BULLISH or SELL+BEARISH (+20 conf bonus) ─────────────────
  const aligned = raw.signal === trendDir;
  if (aligned) {
    const boosted = Math.min(99, raw.confidence + 20);
    return {
      ...raw,
      higherTrend,
      mtfStatus: "ALIGNED",
      confidence: boosted,
      entryQuality: boosted >= 65 ? "CONFIRMED" : "EARLY",
    };
  }

  // ── Counter-trend: trap / strong-reversal escape (penalised, must stay ≥75)
  const isTrap = !!raw.signalLabel && (
    raw.signalLabel.includes("FAKE BREAKOUT") ||
    raw.signalLabel.includes("FAKE BREAKDOWN") ||
    raw.signalLabel.includes("STOP HUNT")
  );
  const isReversal = !!raw.signalLabel && raw.signalLabel.includes("REVERSAL");
  const penalised  = Math.max(0, raw.confidence - 20);

  if ((isTrap || isReversal) && penalised >= 75) {
    // Allowed exception — keep the directional signal but still mark BLOCKED
    // so the UI shows it's counter-trend. The label tells you why it fired.
    return {
      ...raw,
      higherTrend,
      mtfStatus: "BLOCKED",
      confidence: penalised,
      entryQuality: "CONFIRMED",
    };
  }

  // ── Plain block: directional vs higher TF → HOLD ──────────────────────────
  // Per spec, mtfStatus must be WAITING whenever the final signal is HOLD —
  // BLOCKED is reserved for the trap-exception case above where the signal
  // STAYS directional but is counter-trend. The signalLabel still records
  // exactly what was blocked, so the user knows why we held.
  return {
    ...raw,
    signal: "HOLD",
    confidence: Math.max(20, penalised),
    higherTrend,
    mtfStatus: "WAITING",
    signalLabel: `MTF BLOCKED (${raw.signal} vs ${higherTrend})`,
  };
}

// ── Full Filter Pipeline ───────────────────────────────────────────────────────
// Order: confidence → priority → cooldown → reversal lock → 2-candle confirmation
function applyFilters(
  raw: Omit<SignalResult, "timestamp">,
  timeframe: string,
  currentPrice: number,
  lastCandleTs: number,
  indicators: ExtendedIndicators,
): Omit<SignalResult, "timestamp"> {
  // Always surface the detected market regime regardless of outcome.
  const baseMarketState = indicators.marketState;

  // HOLD and SETUP pass straight through (SETUP is informational only — no
  // confirmation, no cooldown, no history, no alerts). Clear any pending state.
  if (raw.signal === "HOLD" || raw.signal === "SETUP") {
    pendingSignal[timeframe] = null;
    return { ...raw, signalStatus: undefined, signalType: undefined, marketState: baseMarketState };
  }

  const signalType = classifySignalType(raw.signalLabel);
  const isReversalSignal = signalType === "REVERSAL";
  const isTrapSignal = !!raw.signalLabel && (
    raw.signalLabel.includes("FAKE BREAKOUT") ||
    raw.signalLabel.includes("FAKE BREAKDOWN") ||
    raw.signalLabel.includes("STOP HUNT")
  );

  // ── 1. Confidence threshold (HARD floor) ─────────────────────────────────
  // EARLY entries (entryQuality="EARLY") may pass at 60+ — they're MTF-promoted
  // trend trades, intentionally preemptive. CONFIRMED still needs the full 65/75.
  const isEarly = raw.entryQuality === "EARLY";
  const minConf = isReversalSignal
    ? MIN_CONFIDENCE_REVERSAL
    : (isEarly ? 60 : MIN_CONFIDENCE_TREND);
  if (raw.confidence < minConf) {
    pendingSignal[timeframe] = null;
    return { ...makeHoldFromResult(raw, Math.min(45, raw.confidence)), marketState: baseMarketState };
  }

  // ── 2. Single active trade rule — only one position open at a time ───────
  const open = checkActiveTrade(timeframe, currentPrice);
  if (open) {
    pendingSignal[timeframe] = null;
    return makeBlocked(raw, baseMarketState, `Active ${open.signal} trade open`);
  }

  // ── 3. Anti-stacking — block same direction near a recent confirmed entry
  const lastConfirmed = lastSignalMemory[timeframe];
  if (
    lastConfirmed &&
    lastConfirmed.signal === raw.signal &&
    Math.abs(currentPrice - lastConfirmed.price) <= PRICE_DENSITY_RANGE_PTS
  ) {
    pendingSignal[timeframe] = null;
    return makeBlocked(raw, baseMarketState, `Stacking — same dir within ${PRICE_DENSITY_RANGE_PTS}pts of last entry`);
  }

  // ── 4. Overextension filter — no chasing extended price away from EMA20.
  //       Trap signals are exempt (those ARE the reversal at extension).
  const ema20 = indicators.ema20;
  const atr = Math.max(indicators.atr, 1e-6);
  const ext = currentPrice - ema20;
  if (!isTrapSignal && !isReversalSignal) {
    if (raw.signal === "BUY"  && ext >  atr * OVEREXTENSION_ATR_MULT) {
      pendingSignal[timeframe] = null;
      return makeBlocked(raw, baseMarketState, "Overextended above EMA20");
    }
    if (raw.signal === "SELL" && ext < -atr * OVEREXTENSION_ATR_MULT) {
      pendingSignal[timeframe] = null;
      return makeBlocked(raw, baseMarketState, "Overextended below EMA20");
    }
  }

  // ── 5. Exhaustion filter — block trend trades when momentum has died.
  //       Reversal & trap signals pass through (they're built for this).
  if (indicators.exhausted && !isReversalSignal && !isTrapSignal) {
    pendingSignal[timeframe] = null;
    return makeBlocked(raw, "EXHAUSTED", "Momentum exhausted (3 wick-candles)");
  }

  // ── 6. Reversal watch — after impulse + rejection, block continuation.
  //       Allow only the opposite-direction (counter-impulse) trade.
  if (indicators.reversalWatchSide && !isTrapSignal) {
    const impulseDir = indicators.reversalWatchSide; // direction of the impulse
    const continuesImpulse =
      (impulseDir === "BULLISH" && raw.signal === "BUY") ||
      (impulseDir === "BEARISH" && raw.signal === "SELL");
    if (continuesImpulse) {
      pendingSignal[timeframe] = null;
      return makeBlocked(raw, "REVERSAL_WATCH", `Reversal watch — block ${raw.signal} after ${impulseDir} impulse`);
    }
  }

  // ── 7. Pullback zone — for trend continuation only, require entry near EMA20
  //       OR a 30–50% retracement of the most recent swing leg (Trend Memory
  //       lets us still take valid trend continuations that aren't hugging
  //       EMA20). Reversal & trap signals are exempt (entries happen at
  //       extremes).
  if (!isReversalSignal && !isTrapSignal) {
    const side = raw.signal as "BUY" | "SELL";
    const pullbackRange = indicators.pullbackRange;
    const z = inExpandedPullbackZone(
      side, currentPrice, ema20, atr,
      indicators.swingHigh1, indicators.swingLow1, pullbackRange,
    );
    if (!z.active) {
      pendingSignal[timeframe] = null;
      return makeBlocked(raw, baseMarketState,
        "Not in pullback zone (too far from EMA20, no 30–50% retrace)");
    }
  }

  // ── 8. Cooldown — block any new signal within 3 mins of last confirmed ──
  if (lastConfirmed && Date.now() - lastConfirmed.timestamp < COOLDOWN_MS) {
    pendingSignal[timeframe] = null;
    return { ...makeHoldFromResult(raw, 30), marketState: baseMarketState };
  }

  // ── 9. Reversal lock — flipping direction needs strong reversal proof.
  //       Trap / stop-hunt signals are exempt: a fresh liquidity grab IS the
  //       strongest reversal proof there is, and that's exactly what we want
  //       to catch.
  if (lastConfirmed && raw.signal !== lastConfirmed.signal && !isTrapSignal) {
    if (!isStrongReversal(raw.signal as "BUY" | "SELL", indicators)) {
      pendingSignal[timeframe] = null;
      return { ...makeHoldFromResult(raw, 32), marketState: baseMarketState };
    }
  }

  // ── 4. 2-candle confirmation persistence ────────────────────────────────
  const pending = pendingSignal[timeframe];
  if (!pending || pending.signal !== raw.signal) {
    // Start a new pending signal — needs to persist for CONFIRMATION_CANDLES
    pendingSignal[timeframe] = {
      signal: raw.signal as "BUY" | "SELL",
      firstCandleTs: lastCandleTs,
      lastCandleTs,
      candleCount: 1,
    };
    return { ...raw, signalStatus: "PENDING", signalType };
  }

  // Same direction pending — increment count when candle ts advances
  if (lastCandleTs > pending.lastCandleTs) {
    pending.lastCandleTs = lastCandleTs;
    pending.candleCount += 1;
  }

  if (pending.candleCount >= CONFIRMATION_CANDLES) {
    // CONFIRMED — clear pending, will be recorded as last confirmed by caller
    pendingSignal[timeframe] = null;
    return { ...raw, signalStatus: "CONFIRMED", signalType };
  }

  // Still waiting for the next candle to lock it in
  return { ...raw, signalStatus: "PENDING", signalType };
}

function makeHoldFromResult(result: Omit<SignalResult, "timestamp">, confidence: number): Omit<SignalResult, "timestamp"> {
  return {
    ...result,
    signal: "HOLD",
    confidence,
    signalStatus: undefined,
    signalType: undefined,
  };
}

/** Soft-block: convert a directional signal to HOLD with a human-readable reason. */
function makeBlocked(
  result: Omit<SignalResult, "timestamp">,
  marketState: "TRENDING" | "EXHAUSTED" | "REVERSAL_WATCH",
  reason: string,
): Omit<SignalResult, "timestamp"> {
  return {
    ...result,
    signal: "HOLD",
    confidence: Math.max(20, Math.min(40, result.confidence - 15)),
    signalStatus: undefined,
    signalType: undefined,
    mtfStatus: "WAITING",
    marketState,
    blockReason: reason,
  };
}

// ── Price Cache ────────────────────────────────────────────────────────────────
let cachedPrice: PriceData | null = null;
let priceExpiry = 0;

let cachedSignal5m: SignalResult | null = null;
let signal5mExpiry = 0;

let cachedSignal1m: SignalResult | null = null;
let signal1mExpiry = 0;

// ── Higher-timeframe (15m) trend cache ───────────────────────────────────────
type HigherTrend = "BULLISH" | "BEARISH" | "NEUTRAL";
let cachedHigherTrend: HigherTrend = "NEUTRAL";
let higherTrendExpiry = 0;

async function getHigherTrend(): Promise<HigherTrend> {
  if (Date.now() < higherTrendExpiry) return cachedHigherTrend;

  const ohlc = await fetchYahooFinance("GC=F", "15m", "5d");
  const closes = ohlc ? cleanArray(ohlc.close).filter(c => c > 0) : [];

  if (closes.length < 50) {
    // Don't override cache on transient fetch failure — keep last known trend
    higherTrendExpiry = Date.now() + 15_000;
    return cachedHigherTrend;
  }

  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];

  // Require small separation to avoid noisy "trend" labels when EMAs are
  // basically on top of each other (sideways 15m).
  const last = closes[closes.length - 1];
  const sepPct = Math.abs(ema20 - ema50) / last;
  let trend: HigherTrend;
  if (sepPct < 0.0005)      trend = "NEUTRAL";
  else if (ema20 > ema50)   trend = "BULLISH";
  else                       trend = "BEARISH";

  cachedHigherTrend  = trend;
  higherTrendExpiry  = Date.now() + 60_000; // 15m candles only update slowly
  return trend;
}

export async function getLivePrice(): Promise<PriceData> {
  const finnhub  = getFinnhubPrice();             // OANDA:XAU_USD spot via WS
  const spot     = !finnhub ? await getSpotPrice() : null; // gold-api / stooq spot fallback
  const cacheTtl = finnhub || spot ? 5000 : 15000;
  if (cachedPrice && Date.now() < priceExpiry) return cachedPrice;

  // Yahoo GC=F gives us 24h high/low/range context (futures track spot closely),
  // but the *displayed* current price always comes from a true spot source so it
  // matches TradingView's OANDA:XAUUSD chart.
  const ohlc = await fetchYahooFinance("GC=F", "5m", "1d");

  if (!ohlc) {
    // Yahoo unavailable — use the freshest spot we have
    const live = finnhub
      ? { price: finnhub.price, source: "finnhub" as const }
      : spot
        ? { price: spot.price, source: spot.source }
        : null;

    if (live) {
      const prev   = cachedPrice?.price ?? live.price;
      const chg    = live.price - prev;
      const chgPct = prev !== 0 ? (chg / prev) * 100 : 0;
      cachedPrice = {
        price: parseFloat(live.price.toFixed(2)),
        change: parseFloat(chg.toFixed(2)),
        changePercent: parseFloat(chgPct.toFixed(4)),
        high24h: parseFloat((cachedPrice?.high24h ?? live.price + 15).toFixed(2)),
        low24h:  parseFloat((cachedPrice?.low24h  ?? live.price - 15).toFixed(2)),
        timestamp: new Date().toISOString(),
        source: live.source as PriceData["source"],
      };
      priceExpiry = Date.now() + cacheTtl;
      return cachedPrice!;
    }
    if (cachedPrice) return cachedPrice;
    const fb = 3300 + (Math.random() - 0.5) * 20;
    return {
      price: parseFloat(fb.toFixed(2)),
      change: parseFloat(((Math.random() - 0.5) * 10).toFixed(2)),
      changePercent: parseFloat(((Math.random() - 0.5) * 0.5).toFixed(2)),
      high24h: parseFloat((fb + 15).toFixed(2)),
      low24h: parseFloat((fb - 15).toFixed(2)),
      timestamp: new Date().toISOString(),
    };
  }

  const closes = cleanArray(ohlc.close);
  const highs  = cleanArray(ohlc.high);
  const lows   = cleanArray(ohlc.low);

  // PRICE SOURCE PRIORITY (must match TradingView OANDA:XAUUSD spot):
  //   1. Finnhub WebSocket (OANDA spot)  — sub-second tick
  //   2. gold-api.com / Stooq spot       — ~5s freshness
  //   3. Yahoo GC=F futures last close   — last resort, drifts vs spot
  const yahooCurrent = closes[closes.length - 1];
  const currentPrice = finnhub
    ? finnhub.price
    : spot
      ? spot.price
      : yahooCurrent;
  const priceSource: PriceData["source"] = finnhub
    ? "finnhub"
    : spot
      ? (spot.source as PriceData["source"])
      : "yahoo";

  // Use spot-anchored 24h range when possible to avoid futures-vs-spot offset
  // contaminating high/low context.
  const futuresOffset = currentPrice - yahooCurrent;
  const high24h      = Math.max(...highs) + (priceSource !== "yahoo" ? futuresOffset : 0);
  const low24h       = Math.min(...lows.filter(l => l > 0)) + (priceSource !== "yahoo" ? futuresOffset : 0);

  const prevClose    = closes[0] + (priceSource !== "yahoo" ? futuresOffset : 0);
  const change       = currentPrice - prevClose;
  const changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;

  cachedPrice = {
    price: parseFloat(currentPrice.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    changePercent: parseFloat(changePercent.toFixed(4)),
    high24h: parseFloat(high24h.toFixed(2)),
    low24h:  parseFloat(low24h.toFixed(2)),
    timestamp: new Date().toISOString(),
    source: priceSource,
  };
  priceExpiry = Date.now() + cacheTtl;
  return cachedPrice!;
}

// ── getSignal ──────────────────────────────────────────────────────────────────
// ── Score-Based Decision Engine (NEW) ─────────────────────────────────────────
// Replaces the old hard-blocking pipeline (applyMtfConfirmation + applyFilters
// gating on MTF/pullback/confirmation). Each side (BUY / SELL) earns a
// weighted score; the higher side wins, the score maps to STRONG / NORMAL /
// WEAK / NONE, and confidence is just (score / 10) × 100. No condition is a
// hard gate by itself — they're all weighted contributors.
//
// Per spec:
//   EMA trend matches direction        → +2
//   Higher TF (15m) matches direction  → +2  (opposite → −2, neutral → 0)
//   Trend Memory matches direction     → +1
//   Pullback zone exists for direction → +2  (else 0, NEVER blocks)
//   Confirmation candle (rejection)    → +2  (else 0, NEVER blocks)
//   Strong breakout + volume spike     → +2  (alternative to pullback)
//   Trap against direction             → −2
//   High volatility spike              → −1
//   ≥ 5 STRONG · ≥ 3 NORMAL · ≥ 2 WEAK · < 2 HOLD
type SignalStrengthBucket = "STRONG" | "NORMAL" | "WEAK" | "NONE";
interface ScoreBreakdown {
  ema: number;
  htf: number;
  momentum: number;
  pullback: number;
  confirmation: number;
  breakout: number;
  trap: number;
  volatility: number;
  // ── Volume confirmation axes (per spec — volume NEVER blocks a trade) ───
  // volume        : +0/+1/+2 standalone volume score (relative to 20-bar SMA)
  // breakoutVolume: +2 / -1 / 0 — validates breakout vs avg volume
  // pullbackVolume: +2 / 0     — bonus when pullback+rejection prints w/ volume
  // stopHunt      : +2 / 0     — long opposite-side wick + volume = liquidity grab
  volume: number;
  breakoutVolume: number;
  pullbackVolume: number;
  stopHunt: number;
  total: number;
}

function classifyMtfAlignment(
  side: "BUY" | "SELL",
  htf: HigherTrend,
): "SUPPORTIVE" | "NEUTRAL" | "CONTRA" {
  if (htf === "NEUTRAL") return "NEUTRAL";
  if (side === "BUY"  && htf === "BULLISH") return "SUPPORTIVE";
  if (side === "SELL" && htf === "BEARISH") return "SUPPORTIVE";
  return "CONTRA";
}

function deriveSignalStrength(score: number): SignalStrengthBucket {
  if (score >= 5) return "STRONG";
  if (score >= 3) return "NORMAL";
  if (score >= 2) return "WEAK";
  return "NONE";
}

function computeSignalScore(
  side: "BUY" | "SELL",
  ind: ExtendedIndicators,
  htf: HigherTrend,
): ScoreBreakdown {
  // EMA trend matches direction → +2
  const emaBull = ind.ema20 > ind.ema50;
  const emaBear = ind.ema20 < ind.ema50;
  const ema =
    (side === "BUY"  && emaBull) ||
    (side === "SELL" && emaBear) ? 2 : 0;

  // HTF (15m) → +2 supportive, −2 contra, 0 neutral
  let htfScore = 0;
  if (htf === "BULLISH") htfScore = side === "BUY"  ? 2 : -2;
  else if (htf === "BEARISH") htfScore = side === "SELL" ? 2 : -2;
  // else neutral → 0

  // Trend Memory matches → +1
  const memBull = ind.momentumBias === "BULLISH";
  const memBear = ind.momentumBias === "BEARISH";
  const momentum =
    (side === "BUY"  && memBull) ||
    (side === "SELL" && memBear) ? 1 : 0;

  // Pullback zone matches direction → +2 (else 0, no block)
  const zoneMatch =
    (side === "BUY"  && ind.zoneStatus === "BUY_ZONE") ||
    (side === "SELL" && ind.zoneStatus === "SELL_ZONE");
  const pullback = zoneMatch ? 2 : 0;

  // Confirmation candle (rejection inside the zone) → +2 (else 0, no block)
  const reversalCandle = ind.pullbackConfirmation === "REJECTION_DETECTED";
  const confirmation = (zoneMatch && reversalCandle) ? 2 : 0;

  // Strong breakout + volume spike → +2 (allows trade WITHOUT pullback zone)
  const breakoutMatch =
    (side === "BUY"  && ind.strongBreakoutBuy) ||
    (side === "SELL" && ind.strongBreakoutSell);
  const breakout = breakoutMatch ? 2 : 0;

  // Trap against direction → −2 (e.g. FAKE_BREAKOUT_SELL while scoring BUY)
  let trap = 0;
  if (ind.trap) {
    const trapAgainstBuy  = side === "BUY"  && (ind.trap === "FAKE_BREAKOUT_SELL" || ind.trap === "STOP_HUNT_SELL");
    const trapAgainstSell = side === "SELL" && (ind.trap === "FAKE_BREAKDOWN_BUY" || ind.trap === "STOP_HUNT_BUY");
    if (trapAgainstBuy || trapAgainstSell) trap = -2;
  }

  // High volatility spike → −1 (ATR / price > 0.5 %)
  const atrPct = ind.atr / Math.max(ind.ema20, 1);
  const volatility = atrPct > 0.005 ? -1 : 0;

  // ── Volume Confirmation (per spec — volume is a BOOSTER, never a blocker) ──
  // We only score volume when we actually have it. Yahoo intraday feeds
  // sometimes return 0-volume bars for futures; in that case all volume axes
  // collapse to 0 so a missing feed doesn't penalise the setup.
  const hasVolume    = ind.volumeAvg > 0 && ind.volumeLast > 0;
  const volAboveAvg  = hasVolume && ind.volumeLast > ind.volumeAvg;
  const volSpike1p5x = hasVolume && ind.volumeLast > ind.volumeAvg * 1.5;

  // STEP 2 — standalone volume score (always added, never blocks):
  //   > 1.5× avg → +2 (institutional activity)
  //   >  1× avg  → +1 (normal confirmation)
  //   else       →  0 (do NOT block)
  const volume =
    volSpike1p5x ? 2 :
    volAboveAvg  ? 1 :
                   0;

  // STEP 3 — breakout validation: a breakout WITHOUT volume is suspect.
  //   breakout + vol > avg → +2 (valid)
  //   breakout + vol ≤ avg → −1 (weak / possible fake)
  //   no breakout         →  0
  // Only applies when we actually have volume data; otherwise stays neutral.
  let breakoutVolume = 0;
  if (breakoutMatch && hasVolume) breakoutVolume = volAboveAvg ? 2 : -1;

  // STEP 4 — pullback validation: zone + reversal candle WITH volume = strong
  // entry; without volume the trade is still allowed (base pullback +
  // confirmation already scored above), this is purely a bonus.
  const pullbackVolume = (zoneMatch && reversalCandle && volAboveAvg) ? 2 : 0;

  // STEP 5 — stop hunt detection: a long wick on the OPPOSITE side of the
  // intended trade, printed on above-average volume, is a classic liquidity
  // grab. wickRatio ≥ 1.5 = "long wick", wick must dominate the body and sit
  // on the side where stops would have been swept (lower wick for BUYs, upper
  // wick for SELLs).
  const longWickThreshold = 1.5;
  const dominantWick = side === "BUY" ? ind.lowerWick : ind.upperWick;
  const otherWick    = side === "BUY" ? ind.upperWick : ind.lowerWick;
  const longWickAgainstSide =
    ind.wickRatio >= longWickThreshold &&
    dominantWick > otherWick &&
    dominantWick >= ind.body * longWickThreshold;
  const stopHunt = (longWickAgainstSide && volAboveAvg) ? 2 : 0;

  // STEP 6 — final score = base score + volumeScore + (vol-conditional bonuses)
  const total =
    ema + htfScore + momentum + pullback + confirmation + breakout +
    trap + volatility +
    volume + breakoutVolume + pullbackVolume + stopHunt;

  return {
    ema, htf: htfScore, momentum, pullback, confirmation, breakout,
    trap, volatility,
    volume, breakoutVolume, pullbackVolume, stopHunt,
    total,
  };
}

function pickDirectionByScore(
  ind: ExtendedIndicators,
  htf: HigherTrend,
): { side: "BUY" | "SELL"; score: ScoreBreakdown } | null {
  const buy  = computeSignalScore("BUY",  ind, htf);
  const sell = computeSignalScore("SELL", ind, htf);
  if (buy.total < 2 && sell.total < 2) return null;
  if (buy.total >  sell.total) return { side: "BUY",  score: buy };
  if (sell.total > buy.total)  return { side: "SELL", score: sell };
  // Tie — break by EMA bias
  return ind.ema20 >= ind.ema50
    ? { side: "BUY",  score: buy  }
    : { side: "SELL", score: sell };
}

function buildScoreLabel(
  side: "BUY" | "SELL",
  strength: SignalStrengthBucket,
  score: ScoreBreakdown,
  mtfAlign: "SUPPORTIVE" | "NEUTRAL" | "CONTRA",
): string {
  // Source label — what part of the score earned the signal:
  //   pullback+confirmation → PULLBACK · CONFIRMED
  //   pullback only         → PULLBACK
  //   breakout              → BREAKOUT
  //   else                  → TREND
  const source =
    score.confirmation > 0 ? "PULLBACK · CONFIRMED" :
    score.pullback     > 0 ? "PULLBACK" :
    score.breakout     > 0 ? "BREAKOUT" :
                             "TREND";
  // Volume / stop-hunt tags are appended when meaningful so the user can see
  // the booster at a glance. Order: STOP-HUNT > VOL+ (spike) > VOL · WEAK
  // (breakout that lacked volume = -1 axis). All purely informational.
  const tags: string[] = [];
  if (score.stopHunt > 0)              tags.push("STOP-HUNT");
  if (score.volume === 2)              tags.push("VOL+");
  else if (score.volume === 1)         tags.push("VOL");
  if (score.breakoutVolume < 0)        tags.push("WEAK BREAKOUT");
  const tagSuffix = tags.length ? ` · ${tags.join(" · ")}` : "";
  return `${strength} ${side} · ${source} · HTF ${mtfAlign}${tagSuffix}`;
}

// ── Risk filters that should still apply (non-strictness related) ─────────────
// Active trade open in this TF, cooldown timer, anti-stacking proximity.
// These are about RISK MANAGEMENT (don't pyramid, don't fire same dir 2x in
// 8pts), not "is this a clean setup".
function applySoftRiskFilters(
  result: Omit<SignalResult, "timestamp">,
  tfKey: string,
  currentPrice: number,
): Omit<SignalResult, "timestamp"> {
  if (result.signal !== "BUY" && result.signal !== "SELL") return result;

  // Active trade in this TF — convert to HOLD with reason
  const active = checkActiveTrade(tfKey, currentPrice);
  if (active) {
    return {
      ...result,
      signal: "HOLD",
      blockReason: `Active ${active.signal} trade in flight`,
      // keep score/strength so UI still shows context
    };
  }

  // 3-min cooldown after the previous confirmed signal
  const last = lastSignalMemory[tfKey];
  if (last && Date.now() - last.timestamp < COOLDOWN_MS) {
    return {
      ...result,
      signal: "HOLD",
      blockReason: "Cooldown — wait 3 min after last signal",
    };
  }

  // Anti-stacking — same direction within 8pts of last signal
  if (last && last.signal === result.signal &&
      Math.abs(currentPrice - last.price) < PRICE_DENSITY_RANGE_PTS) {
    return {
      ...result,
      signal: "HOLD",
      blockReason: `Same-direction signal too close to last (${PRICE_DENSITY_RANGE_PTS}pt window)`,
    };
  }

  return result;
}

// ── Confirmation persistence (PENDING → CONFIRMED) ────────────────────────────
// Doesn't BLOCK — just marks the signalStatus so the UI / Telegram alerts
// can decide whether to act. Per spec, we no longer force HOLD on PENDING.
function trackConfirmationPersistence(
  side: "BUY" | "SELL",
  tfKey: string,
  lastCandleTs: number,
): "PENDING" | "CONFIRMED" {
  const pending = pendingSignal[tfKey];
  if (!pending || pending.signal !== side) {
    pendingSignal[tfKey] = {
      signal: side,
      firstCandleTs: lastCandleTs,
      lastCandleTs,
      candleCount: 1,
    };
    return "PENDING";
  }
  // Same direction — increment count if a NEW candle has formed
  if (lastCandleTs !== pending.lastCandleTs) {
    pending.lastCandleTs = lastCandleTs;
    pending.candleCount += 1;
  }
  return pending.candleCount >= CONFIRMATION_CANDLES ? "CONFIRMED" : "PENDING";
}

// ── New main pipeline — replaces generateSignal + applyMtfConfirmation +
//    applyFilters. Returns Omit<SignalResult, "timestamp">. Trap detections
//    are still respected (high-quality reversal entries) but they go through
//    the score engine too, just with a forced direction.
function runScoreEngine(
  ind: ExtendedIndicators,
  currentPrice: number,
  timeframe: string,
  tfKey: string,
  lastCandleTs: number,
  htf: HigherTrend,
): Omit<SignalResult, "timestamp"> {
  const marketMode: "TRENDING" | "SIDEWAYS" =
    ind.trendDirection === "SIDEWAYS" ? "SIDEWAYS" : "TRENDING";
  const trend: "BULLISH" | "BEARISH" | "NEUTRAL" =
    ind.trendDirection === "BULLISH" ? "BULLISH" :
    ind.trendDirection === "BEARISH" ? "BEARISH" : "NEUTRAL";

  // Trap override — if a trap fires, it's a high-quality reversal entry.
  // Use the trap direction directly; still compute score so the UI sees it.
  let forcedSide: "BUY" | "SELL" | null = null;
  if (ind.trap === "FAKE_BREAKOUT_SELL" || ind.trap === "STOP_HUNT_SELL") forcedSide = "SELL";
  if (ind.trap === "FAKE_BREAKDOWN_BUY" || ind.trap === "STOP_HUNT_BUY")  forcedSide = "BUY";

  let pick: { side: "BUY" | "SELL"; score: ScoreBreakdown } | null;
  if (forcedSide) {
    pick = { side: forcedSide, score: computeSignalScore(forcedSide, ind, htf) };
    // Trap reversals deserve a confidence floor even if score is low,
    // because the pattern itself is the high-quality edge.
    if (pick.score.total < 3) pick.score = { ...pick.score, total: 3 };
  } else {
    pick = pickDirectionByScore(ind, htf);
  }

  const mtfAlign = pick ? classifyMtfAlignment(pick.side, htf) : "NEUTRAL";

  if (!pick) {
    // Score < 2 for both sides → HOLD with informational context
    const hold = makeHold(currentPrice, ind.atr, trend, marketMode, timeframe, ind, 25);
    return {
      ...hold,
      signalStrength: "NONE",
      score: 0,
      higherTrend: htf,
      mtfStatus: mtfAlign,
      zoneStatus: ind.zoneStatus,
      pullbackConfirmation: ind.pullbackConfirmation,
      pullbackState: ind.pullbackState,
      momentumBias: ind.momentumBias,
      momentumScore: ind.momentumScore,
      marketState: ind.marketState,
    };
  }

  const { side, score } = pick;
  const strength = deriveSignalStrength(score.total);
  // confidence = (score / 10) × 100, clamped 5..95
  const confidence = Math.max(5, Math.min(95, Math.round((score.total / 10) * 100)));
  const label = buildScoreLabel(side, strength, score, mtfAlign);

  const base = side === "BUY"
    ? makeBuy(currentPrice, ind.atr, confidence, marketMode, timeframe, ind, label)
    : makeSell(currentPrice, ind.atr, confidence, marketMode, timeframe, ind, label);

  // Confirmation persistence — informational, not a gate.
  const sigStatus = trackConfirmationPersistence(side, tfKey, lastCandleTs);
  // entryQuality reflects confidence band (kept for UI compat).
  const entryQuality: "EARLY" | "CONFIRMED" = confidence >= 65 ? "CONFIRMED" : "EARLY";
  const signalType: "TREND" | "REVERSAL" = forcedSide ? "REVERSAL" : "TREND";

  const enriched: Omit<SignalResult, "timestamp"> = {
    ...base,
    signalStatus: sigStatus,
    signalType,
    entryQuality,
    higherTrend: htf,
    mtfStatus: mtfAlign,
    signalStrength: strength,
    score: score.total,
    scoreBreakdown: {
      ema: score.ema, htf: score.htf, momentum: score.momentum,
      pullback: score.pullback, confirmation: score.confirmation,
      breakout: score.breakout, trap: score.trap, volatility: score.volatility,
      volume: score.volume, breakoutVolume: score.breakoutVolume,
      pullbackVolume: score.pullbackVolume, stopHunt: score.stopHunt,
      total: score.total,
    },
    zoneStatus: ind.zoneStatus,
    pullbackConfirmation: ind.pullbackConfirmation,
    pullbackState: ind.pullbackState,
    momentumBias: ind.momentumBias,
    momentumScore: ind.momentumScore,
    marketState: ind.marketState,
  };

  // Apply only soft risk filters (active trade / cooldown / anti-stacking).
  // These can downgrade to HOLD with a blockReason.
  return applySoftRiskFilters(enriched, tfKey, currentPrice);
}

export async function getSignal(timeframe: string): Promise<SignalResult> {
  const is1m   = timeframe === "1m";
  const cache  = is1m ? cachedSignal1m : cachedSignal5m;
  const expiry = is1m ? signal1mExpiry : signal5mExpiry;

  if (cache && Date.now() < expiry) return cache;

  const interval = is1m ? "1m" : "5m";
  const range    = is1m ? "1h" : "1d";

  // Fetch entry-TF candles, live spot price, and the higher-TF (15m) trend
  // in parallel — they're independent.
  const [ohlc, priceData, higherTrend] = await Promise.all([
    fetchYahooFinance("GC=F", interval, range),
    getLivePrice(),
    getHigherTrend(),
  ]);
  const currentPrice = priceData.price;

  const tfKey = timeframe;
  const prev  = prevState[tfKey] ?? null;

  let indicators: ExtendedIndicators;

  if (ohlc && cleanArray(ohlc.close).filter(c => c > 0).length >= 50) {
    indicators = calcIndicators(ohlc, prev);
  } else {
    // Fallback synthetic indicators when Yahoo data is insufficient
    const rsi   = 40 + Math.random() * 20;
    const base  = currentPrice;
    const macdH = (Math.random() - 0.5) * 0.5;
    const atr   = 3 + Math.random() * 2;
    indicators = {
      rsi,
      ema20: base + (Math.random() - 0.5) * 4,
      ema50: base + (Math.random() - 0.5) * 8,
      macdLine: (Math.random() - 0.5) * 2,
      macdSignal: (Math.random() - 0.5) * 1.5,
      macdHistogram: macdH,
      atr,
      prevMacdHistogram: prev?.macdHistogram ?? macdH,
      prevAtr: prev?.atr ?? atr,
      priceActionBias: "NEUTRAL",
      lastCandleBullish: Math.random() > 0.5,
      breaksPrevHigh: false,
      breaksPrevLow: false,
      resistance: base + 5,
      support: base - 5,
      upperWick: 0,
      lowerWick: 0,
      body: 0,
      wickRatio: 0,
      trap: null,
      exhausted: false,
      reversalWatchSide: null,
      marketState: "TRENDING",
      trendDirection: "SIDEWAYS",
      trendStrength: "RANGE",
      swingHigh1: base + 5,
      swingHigh2: base + 5,
      swingLow1:  base - 5,
      swingLow2:  base - 5,
      pullbackRange: Math.min(6, Math.max(3, atr * 0.5)),
      zoneStatus: "NO_ZONE",
      pullbackConfirmation: "WAITING",
      pullbackState: "NONE",
      momentumBias: "NEUTRAL",
      momentumScore: 0,
      volumeAvg: 0,
      volumeLast: 0,
      volumeSpike: false,
      strongBreakoutBuy: false,
      strongBreakoutSell: false,
    };
  }

  // Update prev state
  prevState[tfKey] = {
    rsi: indicators.rsi,
    macdHistogram: indicators.macdHistogram,
    atr: indicators.atr,
  };

  // Latest candle timestamp drives the 2-candle confirmation logic.
  // Falls back to the current minute bucket when synthetic indicators are used.
  const lastCandleTs =
    ohlc?.timestamps?.[ohlc.timestamps.length - 1] ??
    Math.floor(Date.now() / (is1m ? 60_000 : 300_000));

  // ── Score-Based Engine (replaces generateSignal → applyMtfConfirmation →
  //    applyFilters). No more hard blocks on MTF / pullback / confirmation —
  //    those are score contributors, not gates. The result still carries
  //    blockReason when SOFT risk filters (active trade, cooldown, anti-stack)
  //    fire, since those are about risk management, not setup quality.
  const filteredResult = runScoreEngine(
    indicators, currentPrice, timeframe, tfKey, lastCandleTs, higherTrend,
  );

  // ── Indicator Conflict + Chop + Regime + Permission (NEW) ────────────────
  // Runs AFTER applyFilters so it sees the final signal/confidence, then
  // makes the call on whether the user should actually act on it. The
  // existing engine remains untouched; this is a decision LAYER on top.
  const indicatorBias  = computeIndicatorBias(indicators, higherTrend);
  const conflict       = detectIndicatorConflict(indicatorBias);
  const chopScore      = ohlc
    ? computeChopScore(
        cleanArray(ohlc.close), cleanArray(ohlc.open),
        calcEMA(cleanArray(ohlc.close), 20),
        calcEMA(cleanArray(ohlc.close), 50),
      )
    : 0;
  const marketRegime   = classifyMarketRegime(
    indicators.trendDirection, indicators.trendStrength,
    chopScore, conflict.level,
  );

  // Per the score-engine refactor we no longer demote to CONFLICT on chop /
  // mixed indicators — those are handled as score deductions and permission
  // downgrades. Only escalate to CONFLICT on truly SEVERE indicator splits
  // AND a directional signal that the score engine still wants to fire.
  let decisionSignal = filteredResult.signal;
  if (conflict.level === "SEVERE" && (filteredResult.score ?? 0) < 3 &&
      decisionSignal !== "HOLD" && decisionSignal !== "SETUP") {
    decisionSignal = "CONFLICT";
  }

  const permission = derivePermission(
    decisionSignal,
    filteredResult.signalStatus,
    filteredResult.confidence,
    conflict.level,
    higherTrend,
    marketRegime,
    filteredResult.mtfStatus,
  );

  const bannerMessage = buildBannerMessage(permission, conflict.level, marketRegime, higherTrend);
  const softenedLabel = softenSignalLabel(filteredResult.signalLabel, decisionSignal, permission, indicatorBias);

  // ── Strip trade levels only when permission is BLOCKED ──────────────────
  // Per the score-engine refactor: WATCHLIST setups still expose entry / SL
  // / TP so the user can see what the trade WOULD look like. Only BLOCKED
  // (true HOLD / CONFLICT) hides levels.
  const stripped = permission === "BLOCKED";
  const safeEntry      = stripped ? 0 : filteredResult.entry;
  const safeSL         = stripped ? 0 : filteredResult.stopLoss;
  const safeTP         = stripped ? 0 : filteredResult.takeProfit;
  const safeTP1        = stripped ? undefined : filteredResult.tp1;
  const safeTP2        = stripped ? undefined : filteredResult.tp2;
  const safeZoneStatus = stripped ? "NO_ZONE" : (filteredResult.zoneStatus ?? indicators.zoneStatus);

  // Record a confirmed signal — starts the 3-min cooldown AND opens the
  // single active trade slot. Now ALSO requires permission ≥ QUALIFIED so
  // mixed / blocked setups never enter the active-trade slot.
  if (
    decisionSignal !== "HOLD" && decisionSignal !== "SETUP" && decisionSignal !== "CONFLICT" &&
    filteredResult.signalStatus === "CONFIRMED" &&
    (permission === "QUALIFIED" || permission === "ACTIONABLE")
  ) {
    lastSignalMemory[tfKey] = {
      signal: decisionSignal as "BUY" | "SELL",
      price: currentPrice,
      timestamp: Date.now(),
    };
    activeTrade[tfKey] = {
      signal: decisionSignal as "BUY" | "SELL",
      entry: filteredResult.entry,
      stopLoss: filteredResult.stopLoss,
      takeProfit: filteredResult.takeProfit,
      timestamp: Date.now(),
    };
  }

  const result: SignalResult = {
    ...filteredResult,
    signal: decisionSignal,
    signalLabel: softenedLabel,
    permission,
    marketRegime,
    conflictLevel:   conflict.level,
    conflictReasons: conflict.reasons,
    indicatorBias,
    chopScore,
    bannerMessage,
    entry:      safeEntry,
    stopLoss:   safeSL,
    takeProfit: safeTP,
    tp1:        safeTP1,
    tp2:        safeTP2,
    zoneStatus: safeZoneStatus,
    pullbackConfirmation: filteredResult.pullbackConfirmation ?? indicators.pullbackConfirmation,
    pullbackState: filteredResult.pullbackState ?? indicators.pullbackState,
    momentumBias:  filteredResult.momentumBias  ?? indicators.momentumBias,
    momentumScore: filteredResult.momentumScore ?? indicators.momentumScore,
    timestamp: new Date().toISOString(),
  };

  const signalTtl = isFinnhubConnected() ? 10000 : 20000;
  if (is1m) {
    cachedSignal1m  = result;
    signal1mExpiry  = Date.now() + signalTtl;
  } else {
    cachedSignal5m  = result;
    signal5mExpiry  = Date.now() + signalTtl;
  }

  // Any directional signal enters history — including PENDING ("not started")
  // and WATCHLIST setups — so the user can see every signal the engine fires,
  // not just the ones it deems immediately tradable. SETUP / CONFLICT / HOLD
  // have no direction and are still skipped inside addToHistory.
  if (result.signal === "BUY" || result.signal === "SELL") {
    addToHistory(result);
  }

  return result;
}

// ── History ────────────────────────────────────────────────────────────────────
function addToHistory(signal: SignalResult) {
  // History only stores directional BUY/SELL outcomes — SETUP/CONFLICT/HOLD
  // have no direction and would just clutter the list.
  if (signal.signal !== "BUY" && signal.signal !== "SELL") return;

  const strength = classifySignalByConfidence(signal.confidence);

  // Storage filter for non-STRONG signals only — STRONG signals are *always*
  // stored regardless of MTF / market mode (they cannot be suppressed by
  // pullback / volume / sideways gates per spec).
  if (strength !== "STRONG") {
    const mtfOk =
      signal.mtfStatus === "SUPPORTIVE" ||
      signal.mtfStatus === "ALIGNED" ||
      signal.signalStatus === "CONFIRMED";
    if (!mtfOk) return;
    if (signal.marketMode === "SIDEWAYS") return;
  }

  // Dedup: if the most recent entry for the same timeframe already has the
  // same direction + permission + status within the last 2 minutes, skip it.
  // The signal cache TTL is 10–20s so without this we'd accumulate identical
  // PENDING/WATCHLIST entries every refresh cycle.
  const last = signalHistory.find(h => h.timeframe === signal.timeframe);
  if (
    last &&
    last.signal === signal.signal &&
    last.permission === signal.permission &&
    last.signalStatus === signal.signalStatus &&
    Date.now() - new Date(last.timestamp).getTime() < 2 * 60 * 1000
  ) {
    return;
  }

  const item: HistoryItem = {
    id: historyIdCounter++,
    signal: signal.signal,
    confidence: signal.confidence,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    trend: signal.trend,
    timeframe: signal.timeframe,
    timestamp: signal.timestamp,
    outcome: "PENDING",
    permission: signal.permission,
    signalStatus: signal.signalStatus,
    signalType: strength,
  };
  signalHistory.unshift(item);

  // Per-bucket cap: keep only the latest MAX_PER_BUCKET signals in each
  // strength tier (STRONG / MODERATE / WEAK). Older entries beyond the cap
  // are dropped automatically so the history never grows unbounded.
  const MAX_PER_BUCKET = 20;
  const buckets: Record<string, HistoryItem[]> = { STRONG: [], MODERATE: [], WEAK: [] };
  const others: HistoryItem[] = [];
  for (const h of signalHistory) {
    const tier = h.signalType ?? classifySignalByConfidence(h.confidence);
    if (tier === "STRONG" || tier === "MODERATE" || tier === "WEAK") {
      buckets[tier].push(h);
    } else {
      others.push(h);
    }
  }
  for (const k of Object.keys(buckets)) {
    if (buckets[k].length > MAX_PER_BUCKET) {
      buckets[k] = buckets[k]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, MAX_PER_BUCKET);
    }
  }
  signalHistory = [...buckets.STRONG, ...buckets.MODERATE, ...buckets.WEAK, ...others]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  saveHistory();
  // Only schedule outcome resolution for tradable signals — PENDING/WATCHLIST
  // entries don't represent an active trade so their outcome stays "PENDING".
  if (
    signal.signalStatus === "CONFIRMED" &&
    (signal.permission === "QUALIFIED" || signal.permission === "ACTIONABLE")
  ) {
    setTimeout(() => resolveOutcome(item.id, signal.entry, signal.stopLoss, signal.takeProfit, signal.signal), 5 * 60 * 1000);
  }
}

async function resolveOutcome(id: number, entry: number, sl: number, tp: number, signalType: string) {
  const priceData = await getLivePrice().catch(() => null);
  if (!priceData) return;
  const current = priceData.price;
  const item = signalHistory.find(h => h.id === id);
  if (!item) return;
  if (signalType === "BUY") {
    if (current >= tp) item.outcome = "WIN";
    else if (current <= sl) item.outcome = "LOSS";
  } else if (signalType === "SELL") {
    if (current <= tp) item.outcome = "WIN";
    else if (current >= sl) item.outcome = "LOSS";
  }
}

export function getHistory(): { signals: HistoryItem[]; total: number } {
  // Backfill signalType for older entries persisted before classification existed.
  const signals = signalHistory.map(s =>
    s.signalType ? s : { ...s, signalType: classifySignalByConfidence(s.confidence) }
  );
  return { signals, total: signals.length };
}

export function clearHistory(): { cleared: number } {
  const count = signalHistory.length;
  signalHistory = [];
  historyIdCounter = 1;
  saveHistory();
  return { cleared: count };
}

export { getSessionName };
