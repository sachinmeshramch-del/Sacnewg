// ── Entry Quality Scoring System ──────────────────────────────────────────────
// Aggregates outputs from all protection engines into a single quality grade.
//
// Grade  Score  Meaning
//  A+    85–100  Elite setup — all conditions ideal
//  A     70–84   Strong setup — safe to enter
//  B     55–69   Acceptable — caution warranted
//  C     40–54   Risky — strong reason to skip
//  D     0–39    Reject — do not trade
//
// Inputs from other engines are scored positively (clean) or negatively (risky).
// Minimum score for showing signal to user: 55 (B grade).

export interface EntryQualityInput {
  // From MoveExtensionFilter
  moveExtended:         boolean;
  moveExtensionRatio:   number;
  // From ExhaustionEngine
  exhaustionScore:      number;  // 0–8
  exhaustionDetected:   boolean;
  // From FreshMomentum
  freshMomentum:        boolean;
  momentumStale:        boolean;
  waitingForPullback:   boolean;
  // From ReversalRisk (advancedEngines)
  reversalRisk:         "HIGH" | "MEDIUM" | "LOW";
  // From SRProximity
  srBlocked:            boolean;
  supportNearby:        boolean;
  resistanceNearby:     boolean;
  // From momentumEngine
  momentumQualityScore: number;  // 0–100
  // ATR expansion (from MomentumEngine atrScore)
  atrExpanding:         boolean;
  // Pullback quality (from indicators)
  pullbackConfirmed:    boolean;
  // Candle strength
  strongCandle:         boolean;
  // Signal
  signal:               "BUY" | "SELL" | "HOLD" | "SETUP" | "CONFLICT";
}

export type EntryGrade = "A+" | "A" | "B" | "C" | "D";

export interface EntryQualityResult {
  grade:             EntryGrade;
  score:             number;     // 0–100
  showSignal:        boolean;    // false = score < 55 (grade C)
  reasons:           string[];
  positiveFactors:   string[];
  negativeFactors:   string[];
  label:             string;
}

export function runEntryQualityScoring(input: EntryQualityInput): EntryQualityResult {
  const {
    moveExtended, moveExtensionRatio,
    exhaustionScore, exhaustionDetected,
    freshMomentum, momentumStale, waitingForPullback,
    reversalRisk,
    srBlocked, supportNearby, resistanceNearby,
    momentumQualityScore,
    atrExpanding,
    pullbackConfirmed,
    strongCandle,
    signal,
  } = input;

  if (signal !== "BUY" && signal !== "SELL") {
    return { grade: "D", score: 0, showSignal: false, reasons: ["No directional signal"], positiveFactors: [], negativeFactors: [], label: "NO SIGNAL" };
  }

  let score = 60; // start from neutral
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];

  // ── Positive contributions ────────────────────────────────────────────────
  if (freshMomentum) {
    score += 12;
    positiveFactors.push("Fresh momentum confirmed (+12)");
  }
  if (pullbackConfirmed) {
    score += 10;
    positiveFactors.push("Pullback confirmed (+10)");
  }
  if (strongCandle) {
    score += 8;
    positiveFactors.push("Strong candle (+8)");
  }
  if (atrExpanding) {
    score += 6;
    positiveFactors.push("ATR expanding — volatility building (+6)");
  }
  if (momentumQualityScore >= 75) {
    score += 8;
    positiveFactors.push(`High momentum quality (${momentumQualityScore}) (+8)`);
  } else if (momentumQualityScore >= 60) {
    score += 4;
    positiveFactors.push(`Good momentum quality (${momentumQualityScore}) (+4)`);
  }
  if (reversalRisk === "LOW") {
    score += 5;
    positiveFactors.push("Low reversal risk (+5)");
  }

  // ── Negative contributions ────────────────────────────────────────────────
  if (moveExtended) {
    const penalty = moveExtensionRatio > 2.2 ? -25 : -15;
    score += penalty;
    negativeFactors.push(`Move extended (${moveExtensionRatio.toFixed(1)}× ATR) (${penalty})`);
  }
  if (exhaustionDetected) {
    const penalty = exhaustionScore >= 5 ? -30 : exhaustionScore >= 4 ? -20 : -12;
    score += penalty;
    negativeFactors.push(`Exhaustion detected (score ${exhaustionScore}/8) (${penalty})`);
  } else if (exhaustionScore >= 2) {
    score -= 6;
    negativeFactors.push(`Partial exhaustion signals (${exhaustionScore}/8) (-6)`);
  }
  if (momentumStale) {
    score -= 8;
    negativeFactors.push("Momentum stale — not accelerating (-8)");
  }
  if (waitingForPullback) {
    score -= 18;
    negativeFactors.push("Waiting for pullback — 5+ consecutive bars (-18)");
  }
  if (reversalRisk === "HIGH") {
    score -= 30;
    negativeFactors.push("Reversal risk HIGH (-30)");
  } else if (reversalRisk === "MEDIUM") {
    score -= 10;
    negativeFactors.push("Reversal risk MEDIUM (-10)");
  }
  if (srBlocked) {
    score -= 20;
    negativeFactors.push(`S/R proximity blocking entry (-20)`);
  } else if (supportNearby || resistanceNearby) {
    score -= 8;
    negativeFactors.push("S/R level nearby — reduced target room (-8)");
  }

  // Clamp 0–100
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade: EntryGrade =
    score >= 85 ? "A+" :
    score >= 70 ? "A"  :
    score >= 55 ? "B"  :
    score >= 40 ? "C"  :
    "D";

  const label =
    grade === "A+" ? "ELITE SETUP"      :
    grade === "A"  ? "STRONG SETUP"     :
    grade === "B"  ? "ACCEPTABLE SETUP" :
    grade === "C"  ? "RISKY SETUP"      :
    "REJECT";

  const showSignal = score >= 55;

  const reasons = [
    ...positiveFactors.slice(0, 3),
    ...negativeFactors.slice(0, 3),
  ];

  return { grade, score, showSignal, reasons, positiveFactors, negativeFactors, label };
}
