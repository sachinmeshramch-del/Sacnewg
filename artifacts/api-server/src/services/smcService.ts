import axios from "axios";

interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SmcSetup {
  bos: boolean;
  choch: boolean;
  liquidityGrab: boolean;
  orderBlock: boolean;
  fvg: boolean;
}

interface SmcConfidenceBreakdown {
  trendAlignment: number;
  liquidityConfirmation: number;
  orderBlockReaction: number;
  structureConfirmation: number;
  indicatorSupport: number;
  total: number;
}

interface LiquidityLevel {
  price: number;
  type: "HIGH" | "LOW" | "EQH" | "EQL";
  strength: "MAJOR" | "MINOR";
  grabbed: boolean;
}

interface OrderBlock {
  high: number;
  low: number;
  type: "BULLISH" | "BEARISH";
  timeframe: string;
  active: boolean;
}

interface FairValueGap {
  high: number;
  low: number;
  midpoint: number;
  type: "BULLISH" | "BEARISH";
  filled: boolean;
}

interface SmcSignalResult {
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  marketStructure: "BULLISH" | "BEARISH" | "NEUTRAL";
  htfTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  setup: SmcSetup;
  confidenceBreakdown: SmcConfidenceBreakdown;
  setupDescription: string;
  holdingPeriod: string;
  rsi: number;
  timeframe: string;
  timestamp: string;
}

interface SmcHistoryRecord extends SmcSignalResult {
  id: number;
  setupDescription: string;
  outcome?: "WIN" | "LOSS" | "PENDING";
}

interface SmcZonesResult {
  liquidityLevels: LiquidityLevel[];
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  currentPrice: number;
  timestamp: string;
}

// Signal history store (in-memory, capped at 30)
const signalHistory: SmcHistoryRecord[] = [];
let historyIdCounter = 1;

// ─── Yahoo Finance fetch ────────────────────────────────────────────────────
async function fetchOHLCV(
  interval: "15m" | "1h",
  count = 80
): Promise<OHLCV[]> {
  const range = interval === "1h" ? "30d" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 8000,
  });

  const chart = res.data?.chart?.result?.[0];
  if (!chart) throw new Error("No OHLCV data from Yahoo Finance");

  const timestamps: number[] = chart.timestamp;
  const q = chart.indicators.quote[0];
  const candles: OHLCV[] = timestamps
    .map((t: number, i: number) => ({
      time: t * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] ?? 0,
    }))
    .filter(
      (c: OHLCV) =>
        c.open != null && c.high != null && c.low != null && c.close != null
    );

  return candles.slice(-count);
}

// ─── Technical Indicators ──────────────────────────────────────────────────
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = Math.max(diff, 0);
    const l = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcATR(candles: OHLCV[], period = 14): number {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── SMC Concepts ─────────────────────────────────────────────────────────
function detectMarketStructure(candles: OHLCV[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const recent = candles.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);

  let higherHighs = 0,
    higherLows = 0,
    lowerHighs = 0,
    lowerLows = 0;

  for (let i = 2; i < recent.length; i++) {
    if (highs[i] > highs[i - 2]) higherHighs++;
    if (lows[i] > lows[i - 2]) higherLows++;
    if (highs[i] < highs[i - 2]) lowerHighs++;
    if (lows[i] < lows[i - 2]) lowerLows++;
  }

  if (higherHighs > lowerHighs && higherLows > lowerLows) return "BULLISH";
  if (lowerHighs > higherHighs && lowerLows > higherLows) return "BEARISH";
  return "NEUTRAL";
}

function detectBOS(candles: OHLCV[], structure: "BULLISH" | "BEARISH" | "NEUTRAL"): boolean {
  if (structure === "NEUTRAL") return false;
  const recent = candles.slice(-10);
  const last = candles[candles.length - 1];

  if (structure === "BULLISH") {
    // BOS = price breaks above a previous significant swing high
    const swingHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
    return last.close > swingHigh;
  } else {
    // BOS = price breaks below a previous significant swing low
    const swingLow = Math.min(...recent.slice(0, -1).map((c) => c.low));
    return last.close < swingLow;
  }
}

function detectCHoCH(candles: OHLCV[], prevStructure: "BULLISH" | "BEARISH" | "NEUTRAL", currentStructure: "BULLISH" | "BEARISH" | "NEUTRAL"): boolean {
  return (
    prevStructure !== "NEUTRAL" &&
    currentStructure !== "NEUTRAL" &&
    prevStructure !== currentStructure
  );
}

function detectLiquidityGrab(candles: OHLCV[]): { grabbed: boolean; level: number; dir: "HIGH" | "LOW" } {
  const lookback = candles.slice(-20, -3);
  const recent = candles.slice(-3);
  const last = candles[candles.length - 1];

  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const swingLow = Math.min(...lookback.map((c) => c.low));

  // High grab: wick above swing high then closes below
  const wickAbove = recent.some((c) => c.high > swingHigh && c.close < swingHigh);
  if (wickAbove) {
    return { grabbed: true, level: swingHigh, dir: "HIGH" };
  }

  // Low grab: wick below swing low then closes above
  const wickBelow = recent.some((c) => c.low < swingLow && c.close > swingLow);
  if (wickBelow) {
    return { grabbed: true, level: swingLow, dir: "LOW" };
  }

  return { grabbed: false, level: 0, dir: "HIGH" };
}

function detectOrderBlock(candles: OHLCV[], structure: "BULLISH" | "BEARISH" | "NEUTRAL"): { detected: boolean; high: number; low: number; type: "BULLISH" | "BEARISH" } {
  // Order block = last bearish candle before bullish move (bullish OB) or last bullish candle before bearish move (bearish OB)
  const currentPrice = candles[candles.length - 1].close;
  const lookback = candles.slice(-15, -1);

  if (structure === "BULLISH") {
    // Find last bearish candle before price pumped
    for (let i = lookback.length - 1; i >= 0; i--) {
      const c = lookback[i];
      if (c.close < c.open) {
        // Bearish candle = potential bullish OB
        const obHigh = c.high;
        const obLow = c.low;
        // Price should be at/near the OB now
        if (currentPrice >= obLow && currentPrice <= obHigh * 1.005) {
          return { detected: true, high: obHigh, low: obLow, type: "BULLISH" };
        }
      }
    }
  } else if (structure === "BEARISH") {
    // Find last bullish candle before price dropped
    for (let i = lookback.length - 1; i >= 0; i--) {
      const c = lookback[i];
      if (c.close > c.open) {
        const obHigh = c.high;
        const obLow = c.low;
        if (currentPrice <= obHigh && currentPrice >= obLow * 0.995) {
          return { detected: true, high: obHigh, low: obLow, type: "BEARISH" };
        }
      }
    }
  }

  return { detected: false, high: 0, low: 0, type: "BULLISH" };
}

function detectFVG(candles: OHLCV[]): { detected: boolean; high: number; low: number; type: "BULLISH" | "BEARISH" } {
  // FVG = gap between candle[i-2].high and candle[i].low (bullish) or candle[i-2].low and candle[i].high (bearish)
  for (let i = candles.length - 1; i >= 3; i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];

    // Bullish FVG: c0.high < c2.low
    if (c0.high < c2.low) {
      const gap = c2.low - c0.high;
      if (gap / c2.close > 0.0003) {
        // at least 3bps gap
        return { detected: true, high: c2.low, low: c0.high, type: "BULLISH" };
      }
    }

    // Bearish FVG: c0.low > c2.high
    if (c0.low > c2.high) {
      const gap = c0.low - c2.high;
      if (gap / c2.close > 0.0003) {
        return { detected: true, high: c0.low, low: c2.high, type: "BEARISH" };
      }
    }

    // Only check last 10 candles
    if (candles.length - i > 10) break;
  }
  return { detected: false, high: 0, low: 0, type: "BULLISH" };
}

function buildLiquidityLevels(candles: OHLCV[], currentPrice: number): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  const lookback = candles.slice(-40);

  // Find swing highs and lows
  for (let i = 3; i < lookback.length - 3; i++) {
    const c = lookback[i];
    const prevHighs = lookback.slice(i - 3, i).map((x) => x.high);
    const nextHighs = lookback.slice(i + 1, i + 4).map((x) => x.high);
    const prevLows = lookback.slice(i - 3, i).map((x) => x.low);
    const nextLows = lookback.slice(i + 1, i + 4).map((x) => x.low);

    if (c.high > Math.max(...prevHighs) && c.high > Math.max(...nextHighs)) {
      levels.push({
        price: parseFloat(c.high.toFixed(2)),
        type: "HIGH",
        strength: i < lookback.length - 15 ? "MAJOR" : "MINOR",
        grabbed: currentPrice > c.high,
      });
    }

    if (c.low < Math.min(...prevLows) && c.low < Math.min(...nextLows)) {
      levels.push({
        price: parseFloat(c.low.toFixed(2)),
        type: "LOW",
        strength: i < lookback.length - 15 ? "MAJOR" : "MINOR",
        grabbed: currentPrice < c.low,
      });
    }
  }

  // Check for equal highs/lows (within 0.05%)
  const highs = levels.filter((l) => l.type === "HIGH").sort((a, b) => b.price - a.price);
  const lows = levels.filter((l) => l.type === "LOW").sort((a, b) => a.price - b.price);

  for (let i = 0; i < highs.length - 1; i++) {
    if (Math.abs(highs[i].price - highs[i + 1].price) / highs[i].price < 0.0005) {
      highs[i].type = "EQH";
      highs[i + 1].type = "EQH";
    }
  }
  for (let i = 0; i < lows.length - 1; i++) {
    if (Math.abs(lows[i].price - lows[i + 1].price) / lows[i].price < 0.0005) {
      lows[i].type = "EQL";
      lows[i + 1].type = "EQL";
    }
  }

  return levels.slice(-12);
}

function buildOrderBlocks(candles15m: OHLCV[], candles1h: OHLCV[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  const processCandles = (candles: OHLCV[], tf: string) => {
    for (let i = 3; i < candles.length - 1; i++) {
      const c = candles[i];
      const next = candles[i + 1];
      const isBearishOB = c.close < c.open && next.close > c.high;
      const isBullishOB = c.close > c.open && next.close < c.low;

      if (isBearishOB || isBullishOB) {
        const last = candles[candles.length - 1];
        const inZone = last.close >= c.low && last.close <= c.high;
        blocks.push({
          high: parseFloat(c.high.toFixed(2)),
          low: parseFloat(c.low.toFixed(2)),
          type: isBearishOB ? "BULLISH" : "BEARISH",
          timeframe: tf,
          active: inZone,
        });
      }
    }
  };

  processCandles(candles15m.slice(-20), "15m");
  processCandles(candles1h.slice(-15), "1h");

  return blocks.slice(-8);
}

function buildFVGs(candles: OHLCV[], currentPrice: number): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];

    if (c0.high < c2.low) {
      const gap = c2.low - c0.high;
      if (gap / c2.close > 0.0003) {
        const mid = (c0.high + c2.low) / 2;
        gaps.push({
          high: parseFloat(c2.low.toFixed(2)),
          low: parseFloat(c0.high.toFixed(2)),
          midpoint: parseFloat(mid.toFixed(2)),
          type: "BULLISH",
          filled: currentPrice <= c2.low && currentPrice >= c0.high,
        });
      }
    }
    if (c0.low > c2.high) {
      const gap = c0.low - c2.high;
      if (gap / c2.close > 0.0003) {
        const mid = (c0.low + c2.high) / 2;
        gaps.push({
          high: parseFloat(c0.low.toFixed(2)),
          low: parseFloat(c2.high.toFixed(2)),
          midpoint: parseFloat(mid.toFixed(2)),
          type: "BEARISH",
          filled: currentPrice >= c2.high && currentPrice <= c0.low,
        });
      }
    }
  }
  return gaps.slice(-8);
}

// ─── Main SMC Signal Engine ────────────────────────────────────────────────
export async function getSmcSignal(timeframe: "15m" | "1h" = "15m"): Promise<SmcSignalResult> {
  const [candles15m, candles1h] = await Promise.all([
    fetchOHLCV("15m", 80),
    fetchOHLCV("1h", 60),
  ]);

  const candles = timeframe === "15m" ? candles15m : candles1h;
  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  // Technical indicators
  const rsi = calcRSI(closes.slice(-50));
  const ema9 = calcEMA(closes, 9).slice(-1)[0];
  const ema21 = calcEMA(closes, 21).slice(-1)[0];
  const atr = calcATR(candles.slice(-20));

  // SMC analysis
  const currentStructure = detectMarketStructure(candles);
  const htfStructure = detectMarketStructure(candles1h);
  const prevStructure = detectMarketStructure(candles.slice(0, -5));

  const bos = detectBOS(candles, currentStructure);
  const choch = detectCHoCH(candles, prevStructure, currentStructure);
  const liqGrab = detectLiquidityGrab(candles);
  const ob = detectOrderBlock(candles, currentStructure);
  const fvgResult = detectFVG(candles);

  const setup: SmcSetup = {
    bos,
    choch,
    liquidityGrab: liqGrab.grabbed,
    orderBlock: ob.detected,
    fvg: fvgResult.detected,
  };

  // ─── Confidence Scoring (0-100) ─────────────────────────────────────────
  let trendAlignment = 0;
  let liquidityConfirmation = 0;
  let orderBlockReaction = 0;
  let structureConfirmation = 0;
  let indicatorSupport = 0;

  // 1. Trend Alignment (max 30): LTF + HTF agreement
  if (currentStructure === "BULLISH" && htfStructure === "BULLISH") trendAlignment = 30;
  else if (currentStructure === "BEARISH" && htfStructure === "BEARISH") trendAlignment = 30;
  else if (currentStructure !== "NEUTRAL" && htfStructure === "NEUTRAL") trendAlignment = 18;
  else if (currentStructure === "NEUTRAL") trendAlignment = 5;
  else trendAlignment = 8; // conflicting

  // 2. Liquidity Confirmation (max 20)
  if (liqGrab.grabbed) {
    if (liqGrab.dir === "LOW" && currentStructure === "BULLISH") liquidityConfirmation = 20;
    else if (liqGrab.dir === "HIGH" && currentStructure === "BEARISH") liquidityConfirmation = 20;
    else liquidityConfirmation = 10;
  }

  // 3. Order Block Reaction (max 20)
  if (ob.detected) {
    if (ob.type === "BULLISH" && currentStructure === "BULLISH") orderBlockReaction = 20;
    else if (ob.type === "BEARISH" && currentStructure === "BEARISH") orderBlockReaction = 20;
    else orderBlockReaction = 10;
  }

  // 4. Structure Confirmation (max 15)
  if (bos) structureConfirmation += 8;
  if (choch) structureConfirmation += 7;
  structureConfirmation = Math.min(structureConfirmation, 15);

  // 5. Indicator Support (max 15): RSI + EMA cross
  if (currentStructure === "BULLISH") {
    if (rsi > 50 && rsi < 70) indicatorSupport += 8;
    else if (rsi > 40 && rsi <= 50) indicatorSupport += 4;
    if (ema9 > ema21) indicatorSupport += 7;
  } else if (currentStructure === "BEARISH") {
    if (rsi < 50 && rsi > 30) indicatorSupport += 8;
    else if (rsi < 60 && rsi >= 50) indicatorSupport += 4;
    if (ema9 < ema21) indicatorSupport += 7;
  }
  indicatorSupport = Math.min(indicatorSupport, 15);

  const totalConfidence = trendAlignment + liquidityConfirmation + orderBlockReaction + structureConfirmation + indicatorSupport;

  const confidenceBreakdown: SmcConfidenceBreakdown = {
    trendAlignment: parseFloat(trendAlignment.toFixed(1)),
    liquidityConfirmation: parseFloat(liquidityConfirmation.toFixed(1)),
    orderBlockReaction: parseFloat(orderBlockReaction.toFixed(1)),
    structureConfirmation: parseFloat(structureConfirmation.toFixed(1)),
    indicatorSupport: parseFloat(indicatorSupport.toFixed(1)),
    total: parseFloat(totalConfidence.toFixed(1)),
  };

  // ─── Signal Decision ────────────────────────────────────────────────────
  let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (totalConfidence >= 65) {
    if (currentStructure === "BULLISH") signal = "BUY";
    else if (currentStructure === "BEARISH") signal = "SELL";
  }

  // ─── Entry / SL / TP ───────────────────────────────────────────────────
  const entry = parseFloat(currentPrice.toFixed(2));
  let stopLoss: number;
  let takeProfit: number;

  if (signal === "BUY") {
    const slBase = ob.detected ? ob.low : liqGrab.grabbed ? liqGrab.level : currentPrice - atr * 1.5;
    stopLoss = parseFloat(Math.min(slBase, currentPrice - atr).toFixed(2));
    const risk = entry - stopLoss;
    takeProfit = parseFloat((entry + risk * 2.5).toFixed(2));
  } else if (signal === "SELL") {
    const slBase = ob.detected ? ob.high : liqGrab.grabbed ? liqGrab.level : currentPrice + atr * 1.5;
    stopLoss = parseFloat(Math.max(slBase, currentPrice + atr).toFixed(2));
    const risk = stopLoss - entry;
    takeProfit = parseFloat((entry - risk * 2.5).toFixed(2));
  } else {
    stopLoss = parseFloat((currentPrice - atr * 1.5).toFixed(2));
    takeProfit = parseFloat((currentPrice + atr * 3).toFixed(2));
  }

  // ─── Setup Description ─────────────────────────────────────────────────
  const setupParts: string[] = [];
  if (liqGrab.grabbed) setupParts.push("Liquidity Grab");
  if (ob.detected) setupParts.push("Order Block");
  if (fvgResult.detected) setupParts.push("FVG");
  if (bos) setupParts.push("BOS");
  if (choch) setupParts.push("CHoCH");
  const setupDescription = setupParts.length > 0 ? setupParts.join(" + ") : "No Clear Setup";

  const result: SmcSignalResult = {
    signal,
    confidence: parseFloat(totalConfidence.toFixed(1)),
    entry,
    stopLoss,
    takeProfit,
    marketStructure: currentStructure,
    htfTrend: htfStructure,
    setup,
    confidenceBreakdown,
    setupDescription,
    holdingPeriod: "1-4 hours",
    rsi: parseFloat(rsi.toFixed(1)),
    timeframe,
    timestamp: new Date().toISOString(),
  };

  // Store in history (only non-HOLD with confidence >= 65)
  if (signal !== "HOLD" && totalConfidence >= 65) {
    const record: SmcHistoryRecord = { ...result, id: historyIdCounter++ };
    // Update outcome of previous signals
    signalHistory.forEach((h) => {
      if (h.outcome === undefined || h.outcome === "PENDING") {
        h.outcome = "PENDING";
      }
    });
    signalHistory.unshift(record);
    if (signalHistory.length > 30) signalHistory.pop();
  }

  return result;
}

export async function getSmcHistory() {
  const wins = signalHistory.filter((s) => s.outcome === "WIN").length;
  const total = signalHistory.filter((s) => s.outcome !== undefined).length;
  const winRate = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
  return {
    signals: signalHistory.slice(0, 30),
    total: signalHistory.length,
    winRate,
  };
}

export async function getSmcZones(): Promise<SmcZonesResult> {
  const [candles15m, candles1h] = await Promise.all([
    fetchOHLCV("15m", 60),
    fetchOHLCV("1h", 40),
  ]);
  const currentPrice = candles15m[candles15m.length - 1].close;

  const liquidityLevels = buildLiquidityLevels(candles15m, currentPrice);
  const orderBlocks = buildOrderBlocks(candles15m, candles1h);
  const fairValueGaps = buildFVGs(candles15m.slice(-30), currentPrice);

  return {
    liquidityLevels,
    orderBlocks,
    fairValueGaps,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
  };
}

export async function getSmcPrice() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d`;
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 8000,
  });
  const chart = res.data?.chart?.result?.[0];
  if (!chart) throw new Error("No price data");
  const meta = chart.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const change = parseFloat((price - prevClose).toFixed(2));
  const changePercent = parseFloat(((change / prevClose) * 100).toFixed(3));
  const high24h = meta.regularMarketDayHigh ?? price;
  const low24h = meta.regularMarketDayLow ?? price;
  return {
    price: parseFloat(price.toFixed(2)),
    change,
    changePercent,
    high24h: parseFloat(high24h.toFixed(2)),
    low24h: parseFloat(low24h.toFixed(2)),
    timestamp: new Date().toISOString(),
  };
}
