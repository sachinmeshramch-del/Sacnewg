// ── Support / Resistance Proximity Filter ─────────────────────────────────────
// Prevents selling directly into strong support or buying into strong resistance.
//
// Method:
//   - Identify recent swing highs (resistance) and swing lows (support)
//     from the last 30 bars, using a 3-bar pivot lookback.
//   - Cluster nearby levels (within 0.3 × ATR) into single zones.
//   - For SELL: if the nearest support zone is within ATR × 0.5 → block.
//   - For BUY:  if the nearest resistance zone is within ATR × 0.5 → block.
//   - Soft warning: within ATR × 1.0 (not blocking but confidence penalty).

export interface SRProximityInput {
  high:   number[];
  low:    number[];
  close:  number[];
  atr:    number;
  signal: "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
}

export interface SRProximityResult {
  supportNearby:     boolean;
  resistanceNearby:  boolean;
  nearestSupport:    number | null;
  nearestResistance: number | null;
  supportDistance:   number;   // in ATR units
  resistanceDistance: number;  // in ATR units
  blocked:           boolean;
  blockReason:       string | null;
  warning:           string | null;
  confidencePenalty: number;
}

function detectSwingHighs(highs: number[], lows: number[], lookback = 3): number[] {
  const result: number[] = [];
  const n = highs.length;
  for (let i = lookback; i < n - lookback; i++) {
    const isHigh = highs.slice(i - lookback, i).every(v => v <= highs[i])
                && highs.slice(i + 1, i + lookback + 1).every(v => v <= highs[i]);
    if (isHigh) result.push(highs[i]);
  }
  return result;
}

function detectSwingLows(highs: number[], lows: number[], lookback = 3): number[] {
  const result: number[] = [];
  const n = lows.length;
  for (let i = lookback; i < n - lookback; i++) {
    const isLow = lows.slice(i - lookback, i).every(v => v >= lows[i])
               && lows.slice(i + 1, i + lookback + 1).every(v => v >= lows[i]);
    if (isLow) result.push(lows[i]);
  }
  return result;
}

function clusterLevels(levels: number[], threshold: number): number[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters: number[] = [];
  let group: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= threshold) {
      group.push(sorted[i]);
    } else {
      clusters.push(group.reduce((s, v) => s + v, 0) / group.length);
      group = [sorted[i]];
    }
  }
  clusters.push(group.reduce((s, v) => s + v, 0) / group.length);
  return clusters;
}

export function runSRProximityFilter(input: SRProximityInput): SRProximityResult {
  const { high, low, close, atr, signal } = input;
  const n = close.length;

  const neutral: SRProximityResult = {
    supportNearby: false, resistanceNearby: false,
    nearestSupport: null, nearestResistance: null,
    supportDistance: Infinity, resistanceDistance: Infinity,
    blocked: false, blockReason: null, warning: null, confidencePenalty: 0,
  };

  if (n < 10 || atr <= 0 || (signal !== "BUY" && signal !== "SELL")) return neutral;

  const LOOKBACK = Math.min(n - 6, 30);
  const slice_h = high.slice(n - LOOKBACK - 3, n - 1);
  const slice_l = low.slice(n - LOOKBACK - 3, n - 1);

  const rawResistance = detectSwingHighs(slice_h, slice_l, 3);
  const rawSupport    = detectSwingLows(slice_h, slice_l, 3);

  const clusterThreshold = atr * 0.3;
  const resistance = clusterLevels(rawResistance, clusterThreshold);
  const support    = clusterLevels(rawSupport,    clusterThreshold);

  const price = close[n - 1];

  // Find nearest resistance above price
  const resistAbove = resistance.filter(r => r > price);
  const nearestResistance = resistAbove.length > 0
    ? Math.min(...resistAbove) : null;

  // Find nearest support below price
  const supportBelow = support.filter(s => s < price);
  const nearestSupport = supportBelow.length > 0
    ? Math.max(...supportBelow) : null;

  const resistDist = nearestResistance != null ? (nearestResistance - price) / atr : Infinity;
  const supportDist = nearestSupport != null ? (price - nearestSupport) / atr : Infinity;

  const BLOCK_THRESHOLD = 0.5;
  const WARN_THRESHOLD  = 1.0;

  // ── SELL blocked if near support ─────────────────────────────────────────
  if (signal === "SELL") {
    const supportNearby = supportDist <= WARN_THRESHOLD;
    if (supportDist <= BLOCK_THRESHOLD && nearestSupport != null) {
      return {
        supportNearby: true,
        resistanceNearby: resistDist <= WARN_THRESHOLD,
        nearestSupport,
        nearestResistance,
        supportDistance: supportDist,
        resistanceDistance: resistDist,
        blocked: true,
        blockReason: `SUPPORT NEARBY — price ${supportDist.toFixed(1)}× ATR above support $${nearestSupport.toFixed(2)} (min 0.5× ATR clearance required)`,
        warning: "SUPPORT NEARBY",
        confidencePenalty: -20,
      };
    }
    if (supportNearby && nearestSupport != null) {
      return {
        supportNearby: true,
        resistanceNearby: resistDist <= WARN_THRESHOLD,
        nearestSupport,
        nearestResistance,
        supportDistance: supportDist,
        resistanceDistance: resistDist,
        blocked: false,
        blockReason: null,
        warning: "SUPPORT NEARBY",
        confidencePenalty: -10,
      };
    }
  }

  // ── BUY blocked if near resistance ────────────────────────────────────────
  if (signal === "BUY") {
    const resistNearby = resistDist <= WARN_THRESHOLD;
    if (resistDist <= BLOCK_THRESHOLD && nearestResistance != null) {
      return {
        supportNearby: supportDist <= WARN_THRESHOLD,
        resistanceNearby: true,
        nearestSupport,
        nearestResistance,
        supportDistance: supportDist,
        resistanceDistance: resistDist,
        blocked: true,
        blockReason: `RESISTANCE NEARBY — price ${resistDist.toFixed(1)}× ATR below resistance $${nearestResistance.toFixed(2)} (min 0.5× ATR clearance required)`,
        warning: "RESISTANCE NEARBY",
        confidencePenalty: -20,
      };
    }
    if (resistNearby && nearestResistance != null) {
      return {
        supportNearby: supportDist <= WARN_THRESHOLD,
        resistanceNearby: true,
        nearestSupport,
        nearestResistance,
        supportDistance: supportDist,
        resistanceDistance: resistDist,
        blocked: false,
        blockReason: null,
        warning: "RESISTANCE NEARBY",
        confidencePenalty: -10,
      };
    }
  }

  return {
    ...neutral,
    nearestSupport,
    nearestResistance,
    supportDistance: supportDist,
    resistanceDistance: resistDist,
  };
}
