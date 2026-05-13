// ── Move Extension Filter ─────────────────────────────────────────────────────
// Blocks entries when price has already moved too far from EMA20.
// A SELL triggered deep below EMA20 = chasing a completed bear move.
// A BUY triggered far above EMA20  = chasing a completed bull move.
// Threshold: ATR * 1.5 from EMA20 in the trade direction = EXTENDED.

export interface MoveExtensionInput {
  close:   number[];
  ema20:   number;
  atr:     number;
  signal:  "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
}

export type MoveExtensionLabel = "SELL_MOVE_EXTENDED" | "BUY_MOVE_EXTENDED" | null;

export interface MoveExtensionResult {
  blocked:        boolean;
  label:          MoveExtensionLabel;
  reason:         string | null;
  extensionRatio: number;   // distance / ATR (for UI display)
  confidencePenalty: number; // 0 / -15 / -25
}

export function runMoveExtensionFilter(input: MoveExtensionInput): MoveExtensionResult {
  const { close, ema20, atr, signal } = input;
  const n = close.length;

  if (n === 0 || atr <= 0 || (signal !== "BUY" && signal !== "SELL")) {
    return { blocked: false, label: null, reason: null, extensionRatio: 0, confidencePenalty: 0 };
  }

  const price = close[n - 1];
  const distance = price - ema20;   // + = price above EMA20, − = price below EMA20
  const extensionRatio = Math.abs(distance) / atr;

  // ── SELL: price is already far BELOW EMA20 — the bearish move is exhausted ──
  if (signal === "SELL" && distance < 0) {
    const belowRatio = Math.abs(distance) / atr;
    if (belowRatio > 2.2) {
      return {
        blocked: true,
        label: "SELL_MOVE_EXTENDED",
        reason: `SELL MOVE EXTENDED — price ${belowRatio.toFixed(1)}× ATR below EMA20 (threshold 2.2×)`,
        extensionRatio: belowRatio,
        confidencePenalty: -25,
      };
    }
    if (belowRatio > 1.5) {
      return {
        blocked: false,
        label: "SELL_MOVE_EXTENDED",
        reason: `Sell extension warning — price ${belowRatio.toFixed(1)}× ATR below EMA20`,
        extensionRatio: belowRatio,
        confidencePenalty: -15,
      };
    }
  }

  // ── BUY: price is already far ABOVE EMA20 — the bullish move is exhausted ──
  if (signal === "BUY" && distance > 0) {
    const aboveRatio = distance / atr;
    if (aboveRatio > 2.2) {
      return {
        blocked: true,
        label: "BUY_MOVE_EXTENDED",
        reason: `BUY MOVE EXTENDED — price ${aboveRatio.toFixed(1)}× ATR above EMA20 (threshold 2.2×)`,
        extensionRatio: aboveRatio,
        confidencePenalty: -25,
      };
    }
    if (aboveRatio > 1.5) {
      return {
        blocked: false,
        label: "BUY_MOVE_EXTENDED",
        reason: `Buy extension warning — price ${aboveRatio.toFixed(1)}× ATR above EMA20`,
        extensionRatio: aboveRatio,
        confidencePenalty: -15,
      };
    }
  }

  return { blocked: false, label: null, reason: null, extensionRatio, confidencePenalty: 0 };
}
