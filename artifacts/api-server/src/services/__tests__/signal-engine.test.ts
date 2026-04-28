// Standalone test runner for the new decision-layer engines added to
// goldService.ts (Market Regime, Indicator Conflict, Chop Filter,
// Permission Engine, Banner / Soften UI helpers).
//
//   pnpm --filter @workspace/api-server exec tsx src/services/__tests__/signal-engine.test.ts
//
// Uses no test framework — keeps the dependency surface flat. Each scenario
// asserts the conflict, regime, permission, banner and softened-label outputs
// against the contract documented in the engine source.

import {
  computeIndicatorBias,
  detectIndicatorConflict,
  computeChopScore,
  classifyMarketRegime,
  derivePermission,
  buildBannerMessage,
  softenSignalLabel,
} from "../goldService.js";

type Result = { name: string; ok: boolean; details: string };
const results: Result[] = [];

function record(name: string, ok: boolean, details = "") {
  results.push({ name, ok, details });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${details ? "  — " + details : ""}`);
}

function eq<T>(actual: T, expected: T, label: string): boolean {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.log(`  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

// Tiny helper — produce a "minimal ExtendedIndicators" shape just for
// computeIndicatorBias. computeIndicatorBias only reads the listed fields.
function ind(p: {
  ema20: number; ema50: number;
  macdLine: number; macdSignal: number; macdHistogram: number;
  rsi: number; momentum?: number;
  prevClose?: number;
  trendDirection?: "BULLISH" | "BEARISH" | "SIDEWAYS";
}): any {
  return {
    ema20: p.ema20, ema50: p.ema50,
    macdLine: p.macdLine, macdSignal: p.macdSignal, macdHistogram: p.macdHistogram,
    rsi: p.rsi, momentum: p.momentum ?? 0,
    prevClose: p.prevClose ?? 0,
    trendDirection: p.trendDirection ?? "SIDEWAYS",
  };
}

// ── Scenario 1: Mixed indicators + neutral HTF → QUALIFIED (banner stays) ─────
// Score-engine refactor: indicator conflict no longer demotes to WATCHLIST on
// its own. With 70-confidence the permission lands on QUALIFIED, but the
// "Mixed indicators…" banner is still emitted so the user knows the setup
// isn't clean. softenSignalLabel still rewrites the strong free-text label.
{
  const bias = computeIndicatorBias(
    ind({ ema20: 100, ema50: 99, macdLine: -0.2, macdSignal: 0.1, macdHistogram: -0.3, rsi: 50, momentum: 0 }),
    "NEUTRAL",
  );
  const conflict = detectIndicatorConflict(bias);
  const regime   = classifyMarketRegime("SIDEWAYS", "WEAK", 0.3, conflict.level);
  const perm     = derivePermission("BUY", "CONFIRMED", 70, conflict.level, "NEUTRAL", regime, "ALIGNED");
  const banner   = buildBannerMessage(perm, conflict.level, regime, "NEUTRAL");
  const softened = softenSignalLabel("Strong bullish breakout", "BUY", perm, bias);

  let ok = true;
  ok = eq(conflict.level, "MIXED",     "scenario-1.conflictLevel") && ok;
  ok = eq(regime,         "TRANSITION","scenario-1.regime")        && ok;
  ok = eq(perm,           "QUALIFIED", "scenario-1.permission")    && ok;
  ok = eq(banner,         "Mixed indicators — waiting for structure confirmation", "scenario-1.banner") && ok;
  // QUALIFIED keeps the engine label as-is (no soften), so we just check the
  // helper returned the original string instead of forcing a rewrite.
  ok = eq(softened, "Strong bullish breakout", "scenario-1.softenedLabel") && ok;
  record("S1: mixed + neutral HTF → QUALIFIED (banner stays)", ok, `bias=${JSON.stringify(bias)}`);
}

// ── Scenario 2: Full bearish alignment → SELL · ACTIONABLE ────────────────────
{
  const bias = computeIndicatorBias(
    ind({
      ema20: 95, ema50: 100,                           // EMA bearish
      macdLine: -0.5, macdSignal: -0.1, macdHistogram: -0.4, // MACD bearish
      rsi: 38,                                         // RSI bearish
      momentum: -1.2,                                  // momentum bearish
      prevClose: 96,
      trendDirection: "BEARISH",                       // structure bearish
    }),
    "BEARISH",                                         // HTF bearish
  );
  const conflict = detectIndicatorConflict(bias);
  const regime   = classifyMarketRegime("BEARISH", "STRONG", 0.15, conflict.level);
  // Score-engine refactor: ACTIONABLE threshold dropped to confidence ≥ 60.
  // Both 82 and 70 are now ACTIONABLE under clean bearish alignment. Test the
  // boundary at 55 (still QUALIFIED) to keep the gate exercised.
  const permA    = derivePermission("SELL", "CONFIRMED", 82, conflict.level, "BEARISH", regime, "ALIGNED");
  const permQ    = derivePermission("SELL", "CONFIRMED", 55, conflict.level, "BEARISH", regime, "ALIGNED");
  const banner   = buildBannerMessage(permA, conflict.level, regime, "BEARISH");

  let ok = true;
  ok = eq(conflict.level, "NONE",          "scenario-2.conflictLevel") && ok;
  ok = eq(regime,         "TRENDING_BEAR", "scenario-2.regime")        && ok;
  ok = eq(permA,          "ACTIONABLE",    "scenario-2.permission@82") && ok;
  ok = eq(permQ,          "QUALIFIED",     "scenario-2.permission@55") && ok;
  ok = eq(banner,         undefined,       "scenario-2.banner")        && ok;
  record("S2: full bearish → SELL · ACTIONABLE", ok);
}

// ── Scenario 3: Bullish reversal + structure → BUY · QUALIFIED ────────────────
{
  const bias = computeIndicatorBias(
    ind({
      ema20: 102, ema50: 100,                          // EMA bullish
      macdLine: 0.4, macdSignal: 0.1, macdHistogram: 0.3, // MACD bullish
      rsi: 62,                                         // RSI bullish
      momentum: 0.9,                                   // momentum bullish
      prevClose: 101,
      trendDirection: "BULLISH",                       // structure bullish
    }),
    "BULLISH",                                         // HTF bullish
  );
  const conflict = detectIndicatorConflict(bias);
  const regime   = classifyMarketRegime("BULLISH", "STRONG", 0.2, conflict.level);
  // Score-engine refactor: 72 confidence is well above the new ACTIONABLE
  // threshold (60), so this clean bullish setup graduates to ACTIONABLE.
  const perm     = derivePermission("BUY", "CONFIRMED", 72, conflict.level, "BULLISH", regime, "ALIGNED");
  const banner   = buildBannerMessage(perm, conflict.level, regime, "BULLISH");

  let ok = true;
  ok = eq(conflict.level, "NONE",          "scenario-3.conflictLevel") && ok;
  ok = eq(regime,         "TRENDING_BULL", "scenario-3.regime")        && ok;
  ok = eq(perm,           "ACTIONABLE",    "scenario-3.permission")    && ok;
  ok = eq(banner,         undefined,       "scenario-3.banner")        && ok;
  record("S3: bullish reversal + structure → BUY · ACTIONABLE", ok);
}

// ── Scenario 4: Choppy market → WATCHLIST (banner stays) ─────────────────────
// Score-engine refactor: chop alone no longer hard-blocks. The market is
// still flagged CHOPPY and the "no scalp setups" banner still fires, but
// permission softens to WATCHLIST so users can still see the candidate
// levels — the score itself will tell them how weak the setup is.
{
  // Heavily oscillating candle directions — every other candle flips,
  // EMA20 / EMA50 cross multiple times.
  const closes = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106, 94, 107, 93];
  const opens  = [ 99, 102, 98, 103, 97, 104, 96, 105, 95, 106, 94, 107, 93, 108, 92];
  const ema20  = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
  const ema50  = [100, 100.2, 100.1, 100.3, 100.2, 100.4, 100.3, 100.5, 100.4, 100.6, 100.5, 100.7, 100.6, 100.8, 100.7];
  const chop = computeChopScore(closes, opens, ema20, ema50);

  const bias = computeIndicatorBias(
    ind({ ema20: 100, ema50: 100, macdLine: 0, macdSignal: 0, macdHistogram: 0, rsi: 50 }),
    "NEUTRAL",
  );
  const conflict = detectIndicatorConflict(bias);
  // Force chop > 0.6 by passing it directly to the regime classifier — chop
  // pure signal is independent of indicator bias.
  const regime = classifyMarketRegime("SIDEWAYS", "RANGE", Math.max(chop, 0.7), conflict.level);
  const perm   = derivePermission("BUY", "CONFIRMED", 80, conflict.level, "NEUTRAL", regime, "ALIGNED");
  const banner = buildBannerMessage(perm, conflict.level, regime, "NEUTRAL");

  let ok = true;
  ok = (chop > 0.5)                && eq(true, chop > 0.5,  "scenario-4.chopScore>0.5") && ok;
  ok = eq(regime, "CHOPPY",         "scenario-4.regime")     && ok;
  ok = eq(perm,   "WATCHLIST",      "scenario-4.permission") && ok;
  ok = eq(banner, "Choppy market — no scalp setups", "scenario-4.banner") && ok;
  record("S4: choppy → WATCHLIST (banner stays)", ok, `chopScore=${chop}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} scenarios passed${failed ? `  (${failed} FAILED)` : ""}`);
process.exit(failed ? 1 : 0);
