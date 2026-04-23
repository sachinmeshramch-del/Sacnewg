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

interface SignalResult {
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  marketMode: "TRENDING" | "SIDEWAYS";
  signalLabel?: string;
  signalStatus?: "PENDING" | "CONFIRMED";
  signalType?: "TREND" | "REVERSAL";
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
interface ExtendedIndicators extends Indicators {
  prevMacdHistogram: number;
  prevAtr: number;
  priceActionBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  lastCandleBullish: boolean;
  breaksPrevHigh: boolean;
  breaksPrevLow: boolean;
}

function calcIndicators(ohlc: OHLCData, prev: PrevState | null): ExtendedIndicators {
  const closes = cleanArray(ohlc.close);
  const highs  = cleanArray(ohlc.high);
  const lows   = cleanArray(ohlc.low);
  const opens  = cleanArray(ohlc.open);

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
  const prevHigh       = highs[last - 1] ?? highs[last];
  const prevLow        = lows[last - 1]  ?? lows[last];
  const lastCandleBullish = lastClose > lastOpen;
  const breaksPrevHigh    = lastClose > prevHigh;
  const breaksPrevLow     = lastClose < prevLow;

  return {
    rsi, ema20, ema50,
    macdLine, macdSignal, macdHistogram,
    atr, prevMacdHistogram, prevAtr,
    priceActionBias, lastCandleBullish, breaksPrevHigh, breaksPrevLow,
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
    marketMode,
    timeframe,
    indicators,
  };
}

function makeSell(
  price: number, atr: number, confidence: number,
  marketMode: "TRENDING" | "SIDEWAYS", timeframe: string,
  indicators: ExtendedIndicators, signalLabel: string
): Omit<SignalResult, "timestamp"> {
  const slDist = price * 0.004;
  const tpDist = slDist * 1.5;
  return {
    signal: "SELL",
    confidence: Math.min(95, Math.round(confidence)),
    entry: parseFloat(price.toFixed(2)),
    stopLoss: parseFloat((price + slDist).toFixed(2)),
    takeProfit: parseFloat((price - tpDist).toFixed(2)),
    trend: "BEARISH",
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
  const slDist = price * 0.004;
  const tpDist = slDist * 1.5;
  return {
    signal: "BUY",
    confidence: Math.min(95, Math.round(confidence)),
    entry: parseFloat(price.toFixed(2)),
    stopLoss: parseFloat((price - slDist).toFixed(2)),
    takeProfit: parseFloat((price + tpDist).toFixed(2)),
    trend: "BULLISH",
    marketMode,
    signalLabel,
    timeframe,
    indicators,
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
  const emaSeparationPct = Math.abs(ema20 - ema50) / currentPrice;
  const marketMode: "TRENDING" | "SIDEWAYS" = emaSeparationPct < 0.0008 ? "SIDEWAYS" : "TRENDING";

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

  // ── 5. TRENDING — Trend Direction ────────────────────────────────────────
  const bearishTrend = ema20 < ema50;
  const bullishTrend = ema20 > ema50;

  // MACD direction — RSI no longer blocks SELL in a bearish trend
  const macdBearish = macdLine < macdSignal || macdHistogram < 0;
  const macdBullish = macdLine > macdSignal || macdHistogram > 0;
  const macdBearCross = macdHistogram < 0 && prevMacdHistogram >= 0; // fresh bearish cross
  const macdBullCross = macdHistogram > 0 && prevMacdHistogram <= 0; // fresh bullish cross

  // Pullback detection (price retracing to EMA20 in bearish trend → better SELL entry)
  const nearEma20 = Math.abs(currentPrice - ema20) / currentPrice < 0.0015;
  const pullbackSell = bearishTrend && nearEma20 && !lastCandleBullish; // price tagged EMA20, bearish rejection
  const pullbackBuy  = bullishTrend && nearEma20 &&  lastCandleBullish; // price tagged EMA20, bullish bounce

  // ── 6. BEARISH TREND LOGIC ───────────────────────────────────────────────
  if (bearishTrend) {

    // ── 6a. TREND-FOLLOWING SELL ────────────────────────────────────────
    // RSI is NOT a blocker. MACD alignment is the primary gate.
    // Candle confirmation upgrades confidence but is not required.
    if (macdBearish) {
      let conf = 62; // base: trend + MACD aligned
      conf += 20;    // trend alignment bonus
      if (!lastCandleBullish && breaksPrevLow) conf += 12; // candle breaks low = strong confirmation
      else if (!lastCandleBullish)             conf += 5;  // bearish candle alone = mild confirmation
      if (pullbackSell)  conf += 15; // price retraced to EMA20 → better entry
      if (macdBearCross) conf += 10; // fresh MACD cross → strong momentum
      if (atrRising)     conf += 5;
      if (priceActionBias === "BEARISH") conf += 5;
      const label = pullbackSell ? "PULLBACK SELL" : "TREND FOLLOWING SELL";
      return makeSell(currentPrice, atr, conf, marketMode, timeframe, indicators, label);
    }

    // ── 6b. COUNTER-TREND REVERSAL BUY (only with strong confirmation) ──
    const macdTurningBullish = macdBullCross || (prevMacdHistogram < 0 && macdHistogram > prevMacdHistogram * 0.5);
    if (rsi < 30 && macdTurningBullish) {
      let conf = 55;
      conf += Math.round((30 - rsi) * 1.5);
      if (lastCandleBullish && breaksPrevHigh) conf += 12; // strong candle = more confident
      else if (lastCandleBullish)              conf += 5;
      if (macdBullCross) conf += 10;
      return makeBuy(currentPrice, atr, Math.min(78, conf), marketMode, timeframe, indicators, "REVERSAL BUY");
    }

    return makeHold(currentPrice, atr, "BEARISH", marketMode, timeframe, indicators, 32);
  }

  // ── 7. BULLISH TREND LOGIC ───────────────────────────────────────────────
  if (bullishTrend) {

    // ── 7a. TREND-FOLLOWING BUY ─────────────────────────────────────────
    // MACD alignment is the primary gate; candle confirmation boosts confidence.
    if (macdBullish) {
      let conf = 62;
      conf += 20; // trend alignment bonus
      if (lastCandleBullish && breaksPrevHigh) conf += 12;
      else if (lastCandleBullish)              conf += 5;
      if (pullbackBuy)   conf += 15;
      if (macdBullCross) conf += 10;
      if (atrRising)     conf += 5;
      if (priceActionBias === "BULLISH") conf += 5;
      const label = pullbackBuy ? "PULLBACK BUY" : "TREND FOLLOWING BUY";
      return makeBuy(currentPrice, atr, conf, marketMode, timeframe, indicators, label);
    }

    // ── 7b. COUNTER-TREND SELL (bearish reversal in bullish trend) ──────
    if (rsi > 70 && (macdBearCross || macdHistogram < 0)) {
      let conf = 55;
      conf += Math.round((rsi - 70) * 1.5);
      if (!lastCandleBullish && breaksPrevLow) conf += 12;
      else if (!lastCandleBullish)             conf += 5;
      if (macdBearCross) conf += 10;
      return makeSell(currentPrice, atr, Math.min(78, conf), marketMode, timeframe, indicators, "REVERSAL SELL");
    }

    return makeHold(currentPrice, atr, "BULLISH", marketMode, timeframe, indicators, 32);
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

// ── Full Filter Pipeline ───────────────────────────────────────────────────────
// Order: confidence → priority → cooldown → reversal lock → 2-candle confirmation
function applyFilters(
  raw: Omit<SignalResult, "timestamp">,
  timeframe: string,
  currentPrice: number,
  lastCandleTs: number,
  indicators: ExtendedIndicators,
): Omit<SignalResult, "timestamp"> {
  // HOLD passes straight through; clear any pending state
  if (raw.signal === "HOLD") {
    pendingSignal[timeframe] = null;
    return { ...raw, signalStatus: undefined, signalType: undefined };
  }

  const signalType = classifySignalType(raw.signalLabel);

  // ── 1. Confidence threshold (HARD floor) ─────────────────────────────────
  const minConf = signalType === "REVERSAL" ? MIN_CONFIDENCE_REVERSAL : MIN_CONFIDENCE_TREND;
  if (raw.confidence < minConf) {
    pendingSignal[timeframe] = null;
    return makeHoldFromResult(raw, Math.min(45, raw.confidence));
  }

  // ── 2. Cooldown — block any new signal within 3 mins of last confirmed ──
  const lastConfirmed = lastSignalMemory[timeframe];
  if (lastConfirmed && Date.now() - lastConfirmed.timestamp < COOLDOWN_MS) {
    pendingSignal[timeframe] = null;
    return makeHoldFromResult(raw, 30);
  }

  // ── 3. Reversal lock — flipping direction needs strong reversal proof ───
  if (lastConfirmed && raw.signal !== lastConfirmed.signal) {
    if (!isStrongReversal(raw.signal as "BUY" | "SELL", indicators)) {
      pendingSignal[timeframe] = null;
      return makeHoldFromResult(raw, 32);
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

// ── Price Cache ────────────────────────────────────────────────────────────────
let cachedPrice: PriceData | null = null;
let priceExpiry = 0;

let cachedSignal5m: SignalResult | null = null;
let signal5mExpiry = 0;

let cachedSignal1m: SignalResult | null = null;
let signal1mExpiry = 0;

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
export async function getSignal(timeframe: string): Promise<SignalResult> {
  const is1m   = timeframe === "1m";
  const cache  = is1m ? cachedSignal1m : cachedSignal5m;
  const expiry = is1m ? signal1mExpiry : signal5mExpiry;

  if (cache && Date.now() < expiry) return cache;

  const interval = is1m ? "1m" : "5m";
  const range    = is1m ? "1h" : "1d";

  const ohlc      = await fetchYahooFinance("GC=F", interval, range);
  const priceData = await getLivePrice();
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

  const rawResult     = generateSignal(indicators, currentPrice, timeframe);
  const filteredResult = applyFilters(rawResult, tfKey, currentPrice, lastCandleTs, indicators);

  // Record a confirmed signal — starts the 3-min cooldown
  if (filteredResult.signal !== "HOLD" && filteredResult.signalStatus === "CONFIRMED") {
    lastSignalMemory[tfKey] = {
      signal: filteredResult.signal as "BUY" | "SELL",
      price: currentPrice,
      timestamp: Date.now(),
    };
  }

  const result: SignalResult = {
    ...filteredResult,
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

  // Only confirmed (tradable) signals enter history — pending ones don't
  if (result.signal !== "HOLD" && result.signalStatus === "CONFIRMED") {
    addToHistory(result);
  }

  return result;
}

// ── History ────────────────────────────────────────────────────────────────────
function addToHistory(signal: SignalResult) {
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
  };
  signalHistory.unshift(item);
  if (signalHistory.length > 50) signalHistory = signalHistory.slice(0, 50);
  saveHistory();
  setTimeout(() => resolveOutcome(item.id, signal.entry, signal.stopLoss, signal.takeProfit, signal.signal), 5 * 60 * 1000);
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
  return { signals: signalHistory, total: signalHistory.length };
}

export { getSessionName };
