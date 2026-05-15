/**
 * Candle Aggregator
 * -----------------
 * Builds real-time OHLC candles from spot price polls and serves them to
 * the signal engine so signals fire on the CURRENT forming candle rather
 * than only on fully-closed historical bars.
 *
 * Data flow:
 *   1. On startup: seeds closed historical candles from market data (~5 days)
 *   2. Every 10 s:  fetches the live XAUUSD spot price and updates the
 *                   current forming 5-minute candle
 *   3. When signal is requested: getCandlesWithCurrentBar() returns all
 *      historical closed candles PLUS the current in-progress candle
 *
 * The current-forming candle is the key to earlier signals:
 * if a bullish rejection is forming RIGHT NOW (huge lower wick, body
 * recovering), the signal engine detects it before the candle closes.
 *
 * The spot price sources (gold-api.com → stooq) are the same ones used
 * by spotGoldService.ts — no new external dependencies.
 */

export interface OHLCAgg {
  open:       number[];
  high:       number[];
  low:        number[];
  close:      number[];
  volume:     number[];
  timestamps: number[];
}

interface LiveCandle {
  time:      number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  isClosed:  boolean;
  tickCount: number;
}

const PERIOD_5M         = 300;        // seconds
const MAX_CANDLES       = 600;
const POLL_MS           = 10_000;     // poll every 10 s
const MIN_CANDLES       = 30;         // minimum closed candles before trusted
const FETCH_TIMEOUT_MS  = 5_000;

class CandleAggregator {
  private candles:       LiveCandle[] = [];
  private current:       LiveCandle | null = null;
  private seeded         = false;
  private running        = false;

  // ── Spot price fetching (same sources as spotGoldService) ─────────────────
  private async fetchPrice(): Promise<number> {
    const abort = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

    try {
      const r = await fetch("https://api.gold-api.com/price/XAU", { signal: abort() });
      if (r.ok) {
        const j = await r.json() as { price?: number };
        if (typeof j.price === "number" && isFinite(j.price) && j.price > 0) return j.price;
      }
    } catch { /* fallthrough */ }

    try {
      const r = await fetch("https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlc&h&e=csv", {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: abort(),
      });
      if (r.ok) {
        const txt  = await r.text();
        const cols = txt.trim().split("\n")[1]?.split(",") ?? [];
        const p    = parseFloat(cols[6]);
        if (isFinite(p) && p > 0) return p;
      }
    } catch { /* ignore */ }

    return 0;
  }

  // ── Historical seed (internal; keeps aggregator ready immediately) ─────────
  private async seed(): Promise<void> {
    if (this.seeded) return;
    try {
      const url  = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=5d&includePrePost=false";
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!resp.ok) return;

      const raw   = await resp.json() as any;
      const chart = raw?.chart?.result?.[0];
      if (!chart?.timestamp) return;

      const tss: number[] = chart.timestamp;
      const q             = chart.indicators?.quote?.[0];
      if (!q) return;

      const incoming: LiveCandle[] = [];
      for (let i = 0; i < tss.length; i++) {
        const c = q.close[i] as number | null;
        if (!c || !isFinite(c) || c <= 0) continue;
        incoming.push({
          time:     tss[i],
          open:     q.open[i]   ?? c,
          high:     q.high[i]   ?? c,
          low:      q.low[i]    ?? c,
          close:    c,
          isClosed: true,
          tickCount: 0,
        });
      }

      if (incoming.length >= MIN_CANDLES) {
        this.candles = incoming.slice(-MAX_CANDLES);
        this.seeded  = true;
      }
    } catch { /* seed failed — aggregator will accumulate ticks instead */ }
  }

  // ── Accept an external OHLCAgg (from Finnhub or Yahoo caller) ─────────────
  mergeHistorical(data: OHLCAgg): void {
    if (this.isReady()) return;   // already has enough data
    const incoming: LiveCandle[] = [];
    for (let i = 0; i < data.timestamps.length; i++) {
      const c = data.close[i];
      if (!c || !isFinite(c) || c <= 0) continue;
      incoming.push({
        time:      data.timestamps[i],
        open:      data.open[i]   ?? c,
        high:      data.high[i]   ?? c,
        low:       data.low[i]    ?? c,
        close:     c,
        isClosed:  true,
        tickCount: 0,
      });
    }
    if (incoming.length >= MIN_CANDLES) {
      this.candles = incoming.slice(-MAX_CANDLES);
      this.seeded  = true;
    }
  }

  // ── Add a live price tick ─────────────────────────────────────────────────
  addTick(price: number): void {
    if (!price || !isFinite(price) || price <= 0) return;

    const tSec       = Math.floor(Date.now() / 1000);
    const periodStart = tSec - (tSec % PERIOD_5M);

    if (!this.current || this.current.time !== periodStart) {
      if (this.current) {
        const already = this.candles.some(c => c.time === this.current!.time);
        if (!already) {
          this.current.isClosed = true;
          this.candles.push(this.current);
          if (this.candles.length > MAX_CANDLES) this.candles.shift();
        }
      }
      this.current = {
        time:      periodStart,
        open:      price,
        high:      price,
        low:       price,
        close:     price,
        isClosed:  false,
        tickCount: 1,
      };
    } else {
      this.current.high  = Math.max(this.current.high, price);
      this.current.low   = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.tickCount++;
    }
  }

  // ── Polling loop ──────────────────────────────────────────────────────────
  startPolling(): void {
    if (this.running) return;
    this.running = true;

    // Seed immediately in background (no await — non-blocking)
    void this.seed();

    // First tick after 3 s
    setTimeout(() => void this.fetchPrice().then(p => { if (p > 0) this.addTick(p); }), 3_000);

    // Recurring poll
    setInterval(() => {
      void this.fetchPrice().then(p => { if (p > 0) this.addTick(p); });
    }, POLL_MS);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────
  isReady(): boolean {
    return this.seeded && this.candles.length >= MIN_CANDLES;
  }

  /**
   * Returns closed historical candles (indicators use these).
   */
  getClosedCandles(): OHLCAgg | null {
    if (!this.isReady()) return null;
    return this.toAgg(this.candles);
  }

  /**
   * Returns closed candles + the currently forming bar.
   * This is the key to earlier signals: indicators include what is happening
   * on the CURRENT candle, not just bars that have already closed.
   */
  getCandlesWithCurrentBar(): OHLCAgg | null {
    if (!this.isReady()) return null;
    const all = this.current
      ? [...this.candles, this.current]
      : this.candles;
    return this.toAgg(all);
  }

  getCurrentCandle(): LiveCandle | null {
    return this.current;
  }

  private toAgg(candles: LiveCandle[]): OHLCAgg {
    return {
      open:       candles.map(c => c.open),
      high:       candles.map(c => c.high),
      low:        candles.map(c => c.low),
      close:      candles.map(c => c.close),
      volume:     candles.map(() => 0),
      timestamps: candles.map(c => c.time),
    };
  }
}

// Singleton — shared across all signal requests
export const candleAggregator5m = new CandleAggregator();
