/**
 * Session Filter Engine
 * ---------------------
 * Detects the current XAUUSD trading session and returns a confidence
 * adjustment to apply to the blended confidence score.
 *
 * Gold is most liquid (and most reliable for signals) during the
 * London session and the London/NY overlap window.
 * The Asian session is characteristically low-volume and choppy for gold,
 * so signals generated there receive a meaningful confidence penalty.
 *
 * Sessions (UTC):
 *   London:         07:00 – 16:00
 *   New York:       13:00 – 22:00
 *   London/NY:      13:00 – 16:00  ← highest quality
 *   Asian:          22:00 – 07:00  ← low quality for gold
 *   Off-hours:      gaps not covered above
 */

export type SessionCode    = "LONDON" | "NEW_YORK" | "OVERLAP" | "ASIAN" | "OFF_HOURS";
export type SessionQuality = "HIGH" | "MEDIUM" | "LOW";

export interface SessionInfo {
  session:              SessionCode;
  label:                string;
  active:               boolean;
  quality:              SessionQuality;
  confidenceAdjustment: number;
}

export function getSession(): SessionInfo {
  const now  = new Date();
  const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;

  const inLondon  = utcH >= 7  && utcH < 16;
  const inNewYork = utcH >= 13 && utcH < 22;
  const inOverlap = inLondon && inNewYork;
  const inAsian   = utcH >= 22 || utcH < 7;

  if (inOverlap) {
    return {
      session:              "OVERLAP",
      label:                "LONDON/NY OVERLAP",
      active:               true,
      quality:              "HIGH",
      confidenceAdjustment: +8,
    };
  }

  if (inLondon) {
    return {
      session:              "LONDON",
      label:                "LONDON",
      active:               true,
      quality:              "HIGH",
      confidenceAdjustment: 0,
    };
  }

  if (inNewYork) {
    return {
      session:              "NEW_YORK",
      label:                "NEW YORK",
      active:               true,
      quality:              "HIGH",
      confidenceAdjustment: 0,
    };
  }

  if (inAsian) {
    return {
      session:              "ASIAN",
      label:                "ASIAN SESSION",
      active:               false,
      quality:              "LOW",
      confidenceAdjustment: -20,
    };
  }

  return {
    session:              "OFF_HOURS",
    label:                "OFF HOURS",
    active:               false,
    quality:              "MEDIUM",
    confidenceAdjustment: -10,
  };
}
