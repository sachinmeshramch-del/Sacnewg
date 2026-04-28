# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `artifacts/gold-scalper` (`@workspace/gold-scalper`)

React + Vite web app at `/` (port 5000). Gold Scalper AI — 5-15 minute scalping signals using RSI/EMA9/EMA21/MACD/ATR. Features live Yahoo Finance price, TradingView chart widget, signal history, risk calculator, Telegram alerts.

**Dev proxy** (`vite.config.ts`): `/api` is proxied to `http://localhost:8080` (or `API_PROXY_TARGET`) so the SPA uses relative URLs. Workflow runs both servers together (`PORT=8080` for api-server + `PORT=5000` for the SPA), and Replit's preview hits port 5000 directly.

**Port-routing contract** (critical): Replit's public preview proxy routes `/` → the `localPort` declared in `artifacts/gold-scalper/.replit-artifact/artifact.toml`. That `localPort` MUST match the actual port Vite listens on (`5000`). If the workflow's `PORT=` env diverges from `artifact.toml`'s `localPort`, the public URL will return **502** even though `localhost:<port>` works locally. Both values are kept at `5000`. The api-server's artifact pins `localPort = 8080` and `paths = ["/api"]`, so `/api/*` is served by the public proxy directly without going through Vite.

**Pullback Entry Engine** (`artifacts/api-server/src/services/goldService.ts`): WEAK trend states no longer fire random "near EMA20" entries. Instead, the engine waits for: (1) price inside the EMA20 ± ATR×0.5 zone (clamped 3–6 pts) → `zoneStatus` = `BUY_ZONE`/`SELL_ZONE`; (2) a rejection candle (wick ≥ 1.5× body, matching close direction, real body) → `pullbackConfirmation` = `REJECTION_DETECTED`; (3) RSI inside 40–55 (BUY) or 45–60 (SELL). On confirmation, fires with `signalLabel = BUY_PULLBACK` / `SELL_PULLBACK` and confidence ≥ 70. The MTF + active-trade + EXHAUSTED filters from `applyFilters` still apply on top. The UI shows live "Pullback Zone" / "Confirmation" status badges in `SignalPanel.tsx` regardless of trend strength.

**Risk / Reward Engine** (`computeRiskTargets()` in `goldService.ts`): single source of truth for SL/TP across every directional signal (`makeBuy`, `makeSell`, `tryPullbackEntry`). SL is fixed at `entry ∓ ATR × 1.0` (= 1R risk). TP1 = `entry ± risk × 1.2` (partial profit). TP2 = `entry ± risk × 2.2` (final target); `takeProfit` mirrors TP2 for back-compat. Tunable via the `SL_ATR_MULT` / `TP1_R_MULT` / `TP2_R_MULT` constants. The signal panel shows Entry / SL / TP1 / TP2 in a 4-cell grid with R-multiple labels.

**Trend Memory + Strict Sideways + Pullback States** (`goldService.ts`): four coordinated pieces that fix false sideways labels during pullbacks.
- **Trend Memory** (`calcMomentum()`): signed momentum score = `(close[t] − close[t−8]) / (ATR × 1.5)`. `|score| ≥ 0.6` produces `momentumBias = BULLISH` / `BEARISH`. Used by `classifySmartTrend` to override a SIDEWAYS label when there's been a strong recent move.
- **Strict Sideways** (`isStrictSideways()`): SIDEWAYS now requires ALL three — flat EMA20 (slope < 0.05% over 5 bars), flat EMA50, AND recent 10-bar price range < ATR × 2. Anything else is TRENDING. The old single-rule "EMA separation < 0.08%" check labelled trending pullbacks as sideways.
- **Pullback State** (`pullbackState`): `BULLISH_PULLBACK` when bullish trend + price between EMA50 and EMA20; mirrored for `BEARISH_PULLBACK`. Independent of zone status.
- **Expanded Pullback Zone** (`inExpandedPullbackZone()`): zone is active if EITHER price is near EMA20 (existing rule) OR price has retraced 30–50 % of the most recent confirmed swing leg. Used both for `zoneStatus` display and for the `applyFilters` pullback-zone gate, so deep retracements no longer get blocked.
- **MTF SETUP_FORMING** (`applyMtfConfirmation()`): when higher TF (15m) is trending and the entry TF is in a matching `pullbackState`, signal becomes `SETUP` with `mtfStatus = SETUP_FORMING` and label `SETUP FORMING — <DIR> pullback`. Surfaces "trade brewing" instead of letting the user think the market is dead during a healthy retracement.

UI (`SignalPanel.tsx`) renders new badges: an inline `BULLISH PULLBACK` / `BEARISH PULLBACK` pill, a `SETUP FORMING` MTF status with pulsing dot, and a `Trend Memory` row inside the MTF panel showing the signed momentum score.

**Decision Layer — Regime, Conflict, Chop, Permission** (`goldService.ts`, helpers exported for tests). Sits AFTER `applyFilters` and refines the engine output without rewriting it:
- **Indicator Bias** (`computeIndicatorBias`): per-indicator BULLISH/BEARISH/NEUTRAL vote across `ema`, `macd`, `rsi`, `momentum`, `htf`, `structure`. MACD only counts when both line-vs-signal AND histogram agree.
- **Conflict Engine** (`detectIndicatorConflict`): tallies bull/bear votes → `NONE | MINOR | MIXED | SEVERE` plus human-readable `reasons[]` (e.g. "EMA bearish but MACD bullish", "Higher TF (15m) is neutral").
- **Chop Filter** (`computeChopScore`): 0..1 score combining last-14 candle direction-flip density (65%) + last-20 EMA20/EMA50 cross frequency (35%). > 0.6 ≈ pure consolidation.
- **Market Regime** (`classifyMarketRegime`): single label drawn from chop + conflict + trend → `TRENDING_BULL | TRENDING_BEAR | RANGING | CHOPPY | TRANSITION`. CHOPPY when chop > 0.6 OR conflict SEVERE; TRANSITION when conflict MIXED or trend WEAK.
- **Permission Engine** (`derivePermission`): splits "I see a setup" (signal) from "you should trade it" (permission) → `ACTIONABLE | QUALIFIED | WATCHLIST | BLOCKED`. Hard blocks on SEVERE conflict / CHOPPY regime / mtfStatus BLOCKED. MIXED conflict caps at WATCHLIST. HTF NEUTRAL caps at QUALIFIED unless conf ≥ 80. CONFIRMED + ALIGNED + conf ≥ 75 + NONE conflict = ACTIONABLE.
- **First-class CONFLICT signal**: when permission is BLOCKED due to SEVERE conflict / CHOPPY regime, the engine promotes the displayed `signal` to `"CONFLICT"` (added to the OpenAPI enum).
- **Level stripping**: when permission is BLOCKED or WATCHLIST, `entry`/`stopLoss`/`takeProfit` are zeroed and `zoneStatus = NO_ZONE`. Active-trade slot is only opened when permission ≥ QUALIFIED, so mixed/blocked setups never enter cooldown tracking.
- **UI softening** (`buildBannerMessage`, `softenSignalLabel`): a `bannerMessage` is rendered ("Choppy market — no scalp setups", "Mixed indicators — waiting for structure confirmation", "Watchlist only — context not yet tradable", "Higher TF neutral — caution"), and aggressive labels are softened to "Candidate buy area · …" / "Setup forming · waiting for confirmation" when permission is below QUALIFIED.

UI gating (`SignalPanel.tsx`): renders the Permission + Market Regime + (optional) chop badges row right under the big signal pill; renders the `bannerMessage` and up to 3 `conflictReasons` when MIXED+. Trade-levels grid (Entry/SL/TP1/TP2) is replaced with a "No trade levels" placeholder when permission ∉ {QUALIFIED, ACTIONABLE}. Pullback Zone label de-emphasises BUY/SELL ZONE to "Candidate buy/sell area" until qualified.

**Score-Based Decision Engine** (`runScoreEngine` in `goldService.ts`, replaces the old `generateSignal → applyMtfConfirmation → applyFilters` chain). No more hard-blocking conditions — every check contributes a weighted vote and the strongest direction wins:

| Axis | Vote | Source |
|------|-----:|--------|
| EMA stack agrees | +2 | EMA20 vs EMA50 |
| HTF (15m) supportive / contra | ±2 | `classifyMtfAlignment` → `SUPPORTIVE` / `NEUTRAL` / `CONTRA` |
| Trend memory | +1 | momentum bias matches direction |
| Pullback into EMA20 zone | +2 | `inExpandedPullbackZone` |
| Rejection/confirmation candle | +2 | wick ≥ 1.5× body, persisted via `trackConfirmationPersistence` |
| Strong breakout | +2 | break of last-20 high/low (fallback when no pullback) |
| Fake breakout / trap override | -2 (and forces side flip) | trap detector |
| Volatility spike | -1 | volume > 1.5× 20-bar average |

Strength buckets: **STRONG ≥ 5**, **NORMAL ≥ 3**, **WEAK ≥ 2**, anything below = HOLD. `confidence = clamp(round((score / 10) * 100), 5, 95)`. Direction is picked from the signed score per axis. Trap override forces the opposite side and floors score ≥ 3. Soft risk filters (`applySoftRiskFilters`) still enforce active-trade slot, cooldown, and anti-stack — these are the only remaining hard blocks. Output adds `signalStrength`, `score`, and `scoreBreakdown` (per-axis numbers) on top of the existing `SignalResult`. UI labels surface as `STRONG BUY · PULLBACK · HTF SUPPORTIVE` / `WEAK SELL · BREAKOUT · HTF CONTRA` etc.

**Permission relaxation**: `derivePermission` ACTIONABLE threshold dropped to confidence ≥ 60 (was 75); CONFLICT promotion now requires SEVERE conflict AND score < 3; chop / mixed / CONTRA all fall back to **WATCHLIST** (with levels still visible) instead of BLOCKED. Levels are stripped only when permission is BLOCKED.

**Tests**: `artifacts/api-server/src/services/__tests__/signal-engine.test.ts` — standalone tsx-runnable file with 4 fixtures: (1) mixed + neutral HTF → QUALIFIED with banner, (2) full bearish → ACTIONABLE at conf 82 / QUALIFIED at conf 55, (3) bullish reversal → ACTIONABLE, (4) choppy → WATCHLIST with banner. Run via `pnpm --filter @workspace/api-server exec tsx src/services/__tests__/signal-engine.test.ts`.

### `artifacts/gold-intraday` (`@workspace/gold-intraday`)

React + Vite web app at `/intraday/` (port 23161). Gold Intraday AI Trader — 1-4 hour intraday signals using EMA20/EMA50, support/resistance, multi-timeframe analysis (15m/30m/1h). No Telegram integration.

### `artifacts/smart-gold` (`@workspace/smart-gold`)

React + Vite web app at `/smart-gold/` (port 25990). Smart Gold AI Pro — SMC (Smart Money Concepts) based XAUUSD intraday trading. Features: Break of Structure (BOS), Change of Character (CHoCH), Liquidity Grab, Order Blocks, Fair Value Gap (FVG) detection. Confidence threshold >65% for signals, dual 15m+1H timeframe analysis. No Telegram.

Backend services:
- `artifacts/api-server/src/services/smcService.ts` — full SMC engine
- `artifacts/api-server/src/routes/smc.ts` — SMC routes (`/smc/price`, `/smc/signal`, `/smc/history`, `/smc/zones`)

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
