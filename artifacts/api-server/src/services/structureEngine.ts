// ── Institutional Market Structure Engine ────────────────────────────────────
// Detects HH/HL/LH/LL, BOS, CHOCH, liquidity sweeps, range compression.
// Self-contained — no imports from goldService to avoid circular deps.

export type SwingPoint = { price: number; index: number; type: "HIGH" | "LOW" };
export type StructureLabel = "HH" | "HL" | "LH" | "LL";

export type MarketStructureState =
  | "BULLISH_TRENDING"   // confirmed HH + HL sequence
  | "BEARISH_TRENDING"   // confirmed LH + LL sequence
  | "BOS_BULLISH"        // break of structure to upside (recent swing high broken)
  | "BOS_BEARISH"        // break of structure to downside
  | "CHOCH_BULLISH"      // change of character — bearish trend broken bullish
  | "CHOCH_BEARISH"      // change of character — bullish trend broken bearish
  | "LIQUIDITY_SWEEP"    // spike beyond structure, sharp reversal
  | "RANGE_COMPRESSION"  // tight HH/LL with shrinking range
  | "CHOPPY";            // no clear structure

export interface StructureAnalysis {
  state:              MarketStructureState;
  // Swing point labels for last 4 pivots
  labels:             StructureLabel[];
  // Was there a BOS in the last N bars?
  bosDetected:        boolean;
  bosDirection:       "BULLISH" | "BEARISH" | "NONE";
  // Was there a CHOCH (change of character) in the last N bars?
  chochDetected:      boolean;
  chochDirection:     "BULLISH" | "BEARISH" | "NONE";
  // Liquidity sweep (false breakout + reversal)
  liquiditySweep:     boolean;
  sweepDirection:     "BULLISH_SWEEP" | "BEARISH_SWEEP" | "NONE";
  // Range compression (ATR contracting, candles tight)
  rangeCompression:   boolean;
  // Whether structure permits a BUY or SELL
  buyAllowed:         boolean;
  sellAllowed:        boolean;
  // Human-readable reason when trade is blocked by structure
  blockReason:        string | null;
  // Risk/reward quality from structure perspective
  structureQuality:   "STRONG" | "MODERATE" | "WEAK" | "NONE";
  // Confidence contribution 0–25 (used in weighted confidence model)
  confidenceScore:    number;
  // Debug summary
  debugSummary:       string;
}

// ── Swing Point Detection ─────────────────────────────────────────────────────
// Finds pivot highs and lows using a left-right lookback window.
function detectSwings(
  highs: number[],
  lows:  number[],
  lookback = 3,
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const n = highs.length;
  for (let i = lookback; i < n - lookback; i++) {
    const h = highs[i];
    const l = lows[i];
    // Pivot high: higher than all surrounding bars
    const isHigh = highs.slice(i - lookback, i).every(v => v <= h)
                && highs.slice(i + 1, i + lookback + 1).every(v => v <= h);
    if (isHigh) swings.push({ price: h, index: i, type: "HIGH" });
    // Pivot low: lower than all surrounding bars
    const isLow  = lows.slice(i - lookback, i).every(v => v >= l)
                && lows.slice(i + 1, i + lookback + 1).every(v => v >= l);
    if (isLow)  swings.push({ price: l, index: i, type: "LOW"  });
  }
  return swings;
}

// ── Label Last 4 Swing Points ─────────────────────────────────────────────────
function labelSwings(swings: SwingPoint[]): StructureLabel[] {
  if (swings.length < 2) return [];
  const labels: StructureLabel[] = [];
  const highs = swings.filter(s => s.type === "HIGH");
  const lows  = swings.filter(s => s.type === "LOW");

  for (let i = 1; i < highs.length && labels.length < 4; i++) {
    labels.push(highs[i].price > highs[i - 1].price ? "HH" : "LH");
  }
  for (let i = 1; i < lows.length && labels.length < 4; i++) {
    labels.push(lows[i].price > lows[i - 1].price ? "HL" : "LL");
  }
  return labels;
}

// ── BOS Detection ─────────────────────────────────────────────────────────────
// BOS bullish: close breaks above most recent swing high.
// BOS bearish: close breaks below most recent swing low.
function detectBOS(
  closes:  number[],
  swings:  SwingPoint[],
  lookback = 5,
): { detected: boolean; direction: "BULLISH" | "BEARISH" | "NONE" } {
  if (swings.length < 2 || closes.length < 2) {
    return { detected: false, direction: "NONE" };
  }
  const recentClose = closes[closes.length - 1];
  const prevClose   = closes[closes.length - 2];

  const recentHighs = swings.filter(s => s.type === "HIGH" && s.index < closes.length - lookback);
  const recentLows  = swings.filter(s => s.type === "LOW"  && s.index < closes.length - lookback);

  if (recentHighs.length > 0) {
    const lastHigh = recentHighs[recentHighs.length - 1].price;
    if (prevClose <= lastHigh && recentClose > lastHigh) {
      return { detected: true, direction: "BULLISH" };
    }
  }
  if (recentLows.length > 0) {
    const lastLow = recentLows[recentLows.length - 1].price;
    if (prevClose >= lastLow && recentClose < lastLow) {
      return { detected: true, direction: "BEARISH" };
    }
  }
  return { detected: false, direction: "NONE" };
}

// ── CHOCH Detection ───────────────────────────────────────────────────────────
// CHOCH bullish: was bearish structure (LH+LL), now breaks above last LH → flip.
// CHOCH bearish: was bullish structure (HH+HL), now breaks below last HL → flip.
function detectCHOCH(
  labels:  StructureLabel[],
  closes:  number[],
  swings:  SwingPoint[],
): { detected: boolean; direction: "BULLISH" | "BEARISH" | "NONE" } {
  if (labels.length < 2 || swings.length < 2 || closes.length < 1) {
    return { detected: false, direction: "NONE" };
  }
  const recentClose = closes[closes.length - 1];
  // Bearish structure present (LH + LL dominant)
  const bearishCount = labels.filter(l => l === "LH" || l === "LL").length;
  const bullishCount = labels.filter(l => l === "HH" || l === "HL").length;

  if (bearishCount >= 2) {
    // A close above last LH = CHOCH bullish
    const lastLH = swings.filter(s => s.type === "HIGH").slice(-2, -1)[0];
    if (lastLH && recentClose > lastLH.price) {
      return { detected: true, direction: "BULLISH" };
    }
  }
  if (bullishCount >= 2) {
    // A close below last HL = CHOCH bearish
    const lastHL = swings.filter(s => s.type === "LOW").slice(-2, -1)[0];
    if (lastHL && recentClose < lastHL.price) {
      return { detected: true, direction: "BEARISH" };
    }
  }
  return { detected: false, direction: "NONE" };
}

// ── Liquidity Sweep Detection ─────────────────────────────────────────────────
// Spike past swing extreme then sharp reversal within 1–2 bars.
function detectLiquiditySweep(
  highs:  number[],
  lows:   number[],
  closes: number[],
  swings: SwingPoint[],
  atr:    number,
): { detected: boolean; direction: "BULLISH_SWEEP" | "BEARISH_SWEEP" | "NONE" } {
  const n = closes.length;
  if (n < 4 || swings.length < 2) return { detected: false, direction: "NONE" };

  const lastHigh  = swings.filter(s => s.type === "HIGH").slice(-2, -1)[0];
  const lastLow   = swings.filter(s => s.type === "LOW").slice(-2, -1)[0];
  const barHigh   = highs[n - 2];   // bar before last
  const barLow    = lows[n - 2];
  const barClose  = closes[n - 2];
  const currClose = closes[n - 1];

  // Bearish sweep: spike above swing high then close sharply below
  if (lastHigh && barHigh > lastHigh.price && barClose < lastHigh.price
      && currClose < barClose - atr * 0.3) {
    return { detected: true, direction: "BEARISH_SWEEP" };
  }
  // Bullish sweep: spike below swing low then close sharply above
  if (lastLow && barLow < lastLow.price && barClose > lastLow.price
      && currClose > barClose + atr * 0.3) {
    return { detected: true, direction: "BULLISH_SWEEP" };
  }
  return { detected: false, direction: "NONE" };
}

// ── Range Compression ─────────────────────────────────────────────────────────
// ATR contracting + small candle bodies = consolidation / squeeze.
function detectRangeCompression(
  highs:  number[],
  lows:   number[],
  closes: number[],
  atr:    number,
  lookback = 8,
): boolean {
  const n = closes.length;
  if (n < lookback + 4) return false;
  // Average range of the recent lookback bars
  let recentRange = 0;
  for (let i = n - lookback; i < n; i++) {
    recentRange += highs[i] - lows[i];
  }
  recentRange /= lookback;
  // Compare with ATR: if recent range < 60% of ATR, it's compressed
  return recentRange < atr * 0.6;
}

// ── Determine overall structure state ────────────────────────────────────────
function classifyStructureState(
  labels:      StructureLabel[],
  bos:         { detected: boolean; direction: "BULLISH" | "BEARISH" | "NONE" },
  choch:       { detected: boolean; direction: "BULLISH" | "BEARISH" | "NONE" },
  sweep:       { detected: boolean; direction: "BULLISH_SWEEP" | "BEARISH_SWEEP" | "NONE" },
  compressed:  boolean,
): MarketStructureState {
  // Priority 1: CHOCH (change of character = strongest reversal signal)
  if (choch.detected) {
    return choch.direction === "BULLISH" ? "CHOCH_BULLISH" : "CHOCH_BEARISH";
  }
  // Priority 2: Liquidity sweep
  if (sweep.detected) return "LIQUIDITY_SWEEP";
  // Priority 3: Range compression
  if (compressed) return "RANGE_COMPRESSION";
  // Priority 4: BOS
  if (bos.detected) {
    return bos.direction === "BULLISH" ? "BOS_BULLISH" : "BOS_BEARISH";
  }
  // Priority 5: Trend from swing labels
  if (labels.length >= 2) {
    const hhhl = labels.filter(l => l === "HH" || l === "HL").length;
    const lhll = labels.filter(l => l === "LH" || l === "LL").length;
    if (hhhl >= 2 && hhhl > lhll) return "BULLISH_TRENDING";
    if (lhll >= 2 && lhll > hhhl) return "BEARISH_TRENDING";
  }
  return "CHOPPY";
}

// ── Main Export ───────────────────────────────────────────────────────────────
export function runStructureAnalysis(
  highs:  number[],
  lows:   number[],
  closes: number[],
  ema20:  number,
  ema50:  number,
  atr:    number,
  currentSignalSide: "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT",
): StructureAnalysis {
  const swings = detectSwings(highs, lows, 3);
  const labels = labelSwings(swings);
  const bos    = detectBOS(closes, swings, 5);
  const choch  = detectCHOCH(labels, closes, swings);
  const sweep  = detectLiquiditySweep(highs, lows, closes, swings, atr);
  const compressed = detectRangeCompression(highs, lows, closes, atr, 8);

  const state = classifyStructureState(labels, bos, choch, sweep, compressed);

  // ── Buy/Sell permission from structure ──────────────────────────────────
  // BUY needs: bullish structure + no bearish CHOCH
  const bullishStates: MarketStructureState[] = [
    "BULLISH_TRENDING", "BOS_BULLISH", "CHOCH_BULLISH",
  ];
  const bearishStates: MarketStructureState[] = [
    "BEARISH_TRENDING", "BOS_BEARISH", "CHOCH_BEARISH",
  ];

  const priceAboveEMAs = closes.length > 0
    && closes[closes.length - 1] > ema20 && closes[closes.length - 1] > ema50;
  const priceBelowEMAs = closes.length > 0
    && closes[closes.length - 1] < ema20 && closes[closes.length - 1] < ema50;
  const emasBullish = ema20 > ema50;
  const emasBearish = ema20 < ema50;

  // BUY blocked if: bearish CHOCH, bearish structure, price below EMAs, choppy/compressed
  const bearishChoch = choch.detected && choch.direction === "BEARISH";
  const bullishChoch = choch.detected && choch.direction === "BULLISH";

  let buyAllowed  = false;
  let sellAllowed = false;
  let blockReason: string | null = null;

  if (state === "CHOPPY" || state === "RANGE_COMPRESSION") {
    buyAllowed  = false;
    sellAllowed = false;
    blockReason = state === "CHOPPY" ? "Structure unclear — CHOPPY" : "Range compression — no directional edge";
  } else if (state === "LIQUIDITY_SWEEP") {
    // Sweep: allow only in sweep direction (counter-sweep entry)
    buyAllowed  = sweep.direction === "BULLISH_SWEEP";
    sellAllowed = sweep.direction === "BEARISH_SWEEP";
    blockReason = buyAllowed || sellAllowed ? null : "Liquidity sweep — unclear direction";
  } else {
    // Bullish structure conditions
    buyAllowed =
      (bullishStates.includes(state) || bos.direction === "BULLISH") &&
      !bearishChoch &&
      priceAboveEMAs &&
      emasBullish;

    // Bearish structure conditions
    sellAllowed =
      (bearishStates.includes(state) || bos.direction === "BEARISH") &&
      !bullishChoch &&
      priceBelowEMAs &&
      emasBearish;

    if (currentSignalSide === "BUY" && !buyAllowed) {
      if (!emasBullish)     blockReason = "EMA20 below EMA50 — bearish structure";
      else if (!priceAboveEMAs) blockReason = "Price below EMAs — no buy structure";
      else if (bearishChoch)    blockReason = "Bearish CHOCH detected — reversal risk";
      else                      blockReason = `Structure: ${state} — buy not confirmed`;
    }
    if (currentSignalSide === "SELL" && !sellAllowed) {
      if (!emasBearish)      blockReason = "EMA20 above EMA50 — bullish structure";
      else if (!priceBelowEMAs) blockReason = "Price above EMAs — no sell structure";
      else if (bullishChoch)    blockReason = "Bullish CHOCH detected — reversal risk";
      else                      blockReason = `Structure: ${state} — sell not confirmed`;
    }
  }

  // ── Structure quality + confidence score ─────────────────────────────────
  let structureQuality: StructureAnalysis["structureQuality"] = "NONE";
  let confidenceScore = 0;

  if (state === "BOS_BULLISH" || state === "BOS_BEARISH") {
    structureQuality = "STRONG"; confidenceScore = 25;
  } else if (state === "CHOCH_BULLISH" || state === "CHOCH_BEARISH") {
    structureQuality = "STRONG"; confidenceScore = 22;
  } else if (state === "BULLISH_TRENDING" || state === "BEARISH_TRENDING") {
    structureQuality = "MODERATE"; confidenceScore = 18;
  } else if (state === "LIQUIDITY_SWEEP") {
    structureQuality = "MODERATE"; confidenceScore = 15;
  } else if (state === "RANGE_COMPRESSION") {
    structureQuality = "WEAK"; confidenceScore = 5;
  } else {
    structureQuality = "NONE"; confidenceScore = 0;
  }

  // Reduce score when structure says BLOCK
  if ((currentSignalSide === "BUY" && !buyAllowed) ||
      (currentSignalSide === "SELL" && !sellAllowed)) {
    confidenceScore = Math.floor(confidenceScore * 0.3);
  }

  const debugSummary = [
    `state=${state}`,
    bos.detected ? `BOS=${bos.direction}` : "",
    choch.detected ? `CHOCH=${choch.direction}` : "",
    sweep.detected ? `SWEEP=${sweep.direction}` : "",
    compressed ? "COMPRESSED" : "",
    `labels=[${labels.join(",")}]`,
    `buyOK=${buyAllowed}`,
    `sellOK=${sellAllowed}`,
  ].filter(Boolean).join(" | ");

  return {
    state,
    labels,
    bosDetected:      bos.detected,
    bosDirection:     bos.direction,
    chochDetected:    choch.detected,
    chochDirection:   choch.direction,
    liquiditySweep:   sweep.detected,
    sweepDirection:   sweep.direction,
    rangeCompression: compressed,
    buyAllowed,
    sellAllowed,
    blockReason,
    structureQuality,
    confidenceScore,
    debugSummary,
  };
}
