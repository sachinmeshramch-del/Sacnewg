import WebSocket from "ws";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? "";
const GOLD_SYMBOL    = "OANDA:XAU_USD";
const WS_URL         = `wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`;
const REST_BASE      = "https://finnhub.io/api/v1";
const REST_TIMEOUT_MS = 8_000;

// ── WebSocket reconnect config ─────────────────────────────────────────────
const MIN_RECONNECT_MS = 15_000;
const MAX_RECONNECT_MS = 300_000;
let reconnectDelay = MIN_RECONNECT_MS;

// ── Types ──────────────────────────────────────────────────────────────────
interface FinnhubTrade {
  p: number;  // price
  s: string;  // symbol
  t: number;  // timestamp (ms)
  v: number;  // volume
}

interface FinnhubMessage {
  type: "trade" | "ping";
  data?: FinnhubTrade[];
}

interface LivePrice {
  price: number;
  timestamp: number;
}

/** OHLC candle data — matches the OHLCData interface in goldService.ts */
export interface OHLCData {
  open:       number[];
  high:       number[];
  low:        number[];
  close:      number[];
  volume:     number[];
  timestamps: number[];
}

// Finnhub resolution codes (maps human interval strings → Finnhub codes)
const RESOLUTION_MAP: Record<string, string> = {
  "1m":  "1",
  "5m":  "5",
  "15m": "15",
  "30m": "30",
  "1h":  "60",
};

// Cache TTL per resolution — shorter for faster timeframes
const CANDLE_TTL_MS: Record<string, number> = {
  "1":  20_000,   // 20s for 1m bars
  "5":  30_000,   // 30s for 5m bars
  "15": 90_000,   // 90s for 15m bars
  "60": 120_000,  // 2min for 1h bars
};

interface CandleCache {
  data:   OHLCData;
  expiry: number;
}
const candleCache = new Map<string, CandleCache>();

// ── WebSocket state ────────────────────────────────────────────────────────
let latestPrice:    LivePrice | null = null;
let ws:             WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting =  false;

// ── WebSocket connection ───────────────────────────────────────────────────
function connect() {
  if (!FINNHUB_API_KEY) {
    console.warn("[Finnhub] No API key set, skipping WebSocket connection.");
    return;
  }

  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;

  isConnecting = true;
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    isConnecting = false;
    reconnectDelay = MIN_RECONNECT_MS;
    console.log("[Finnhub] WebSocket connected.");
    ws!.send(JSON.stringify({ type: "subscribe", symbol: GOLD_SYMBOL }));
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const msg: FinnhubMessage = JSON.parse(raw.toString());
      if (msg.type === "trade" && msg.data && msg.data.length > 0) {
        const trades = msg.data.filter(d => d.s === GOLD_SYMBOL);
        if (trades.length > 0) {
          const latest = trades[trades.length - 1];
          latestPrice = { price: latest.p, timestamp: latest.t };
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    isConnecting = false;
    console.log(`[Finnhub] WebSocket closed. Reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    isConnecting = false;
    const is429 = err.message.includes("429");
    if (is429) reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    console.error(`[Finnhub] WebSocket error: ${err.message}. Next retry in ${Math.round(reconnectDelay / 1000)}s.`);
    ws?.terminate();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_MS);
    connect();
  }, reconnectDelay);
}

// Start WebSocket on module load
connect();

// Keep-alive ping every 30s
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30_000);

// ── REST candle fetching ───────────────────────────────────────────────────

/**
 * Calls the Finnhub forex/candle REST endpoint directly.
 * Returns null when no API key is set, on network error, or when Finnhub
 * returns s:"no_data".
 */
async function fetchFinnhubCandlesRaw(
  resolution: string,
  fromUnix:   number,
  toUnix:     number,
): Promise<OHLCData | null> {
  if (!FINNHUB_API_KEY) return null;

  const url = `${REST_BASE}/forex/candle?symbol=${GOLD_SYMBOL}&resolution=${resolution}&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[Finnhub REST] Candle fetch failed: HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as {
      s: string;
      c: number[];
      h: number[];
      l: number[];
      o: number[];
      t: number[];
      v?: number[];
    };

    if (data.s !== "ok" || !Array.isArray(data.c) || data.c.length === 0) {
      return null;
    }

    return {
      close:      data.c,
      high:       data.h,
      low:        data.l,
      open:       data.o,
      volume:     data.v ?? data.c.map(() => 0),
      timestamps: data.t,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name !== "AbortError") {
      console.warn(`[Finnhub REST] Candle fetch error: ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * Fetches XAUUSD OHLC candles from Finnhub REST API with in-memory caching.
 * Results are cached per (resolution × lookback) to minimise API calls.
 *
 * @param interval     - "1m" | "5m" | "15m" | "30m" | "1h"
 * @param lookbackDays - how many calendar days of history to request
 * @returns OHLCData or null when no API key / all sources fail
 */
export async function getCandles(
  interval:     string,
  lookbackDays: number,
): Promise<OHLCData | null> {
  const resolution = RESOLUTION_MAP[interval] ?? "5";
  const cacheKey   = `${resolution}:${lookbackDays}`;
  const cached     = candleCache.get(cacheKey);
  const ttl        = CANDLE_TTL_MS[resolution] ?? 60_000;

  if (cached && Date.now() < cached.expiry) return cached.data;

  const toUnix   = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - lookbackDays * 24 * 60 * 60;

  const data = await fetchFinnhubCandlesRaw(resolution, fromUnix, toUnix);
  if (data) {
    candleCache.set(cacheKey, { data, expiry: Date.now() + ttl });
    return data;
  }

  // Fetch failed — return stale cache if available rather than null
  return cached?.data ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns the latest XAUUSD price from the Finnhub WebSocket.
 * Returns null if no price has arrived yet or the last tick is >2 minutes old.
 */
export function getFinnhubPrice(): LivePrice | null {
  if (!latestPrice) return null;
  if (Date.now() - latestPrice.timestamp > 2 * 60 * 1000) return null;
  return latestPrice;
}

/** True when the WebSocket is actively connected. */
export function isFinnhubConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/** True when an API key is configured (enables REST candle calls). */
export function hasFinnhubKey(): boolean {
  return FINNHUB_API_KEY.length > 0;
}
