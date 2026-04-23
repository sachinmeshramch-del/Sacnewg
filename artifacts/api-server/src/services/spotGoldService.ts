// Live XAU/USD spot price from free public sources.
// Aligns the dashboard with TradingView's OANDA:XAUUSD feed (vs Yahoo's GC=F futures
// which drifts $5–$30 above spot and produces "phantom" signals on the wrong price).

interface SpotPrice {
  price: number;
  timestamp: number;
  source: "gold-api" | "stooq";
}

let cached: SpotPrice | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 4_000;

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoldApi(): Promise<SpotPrice | null> {
  try {
    const r = await fetchWithTimeout("https://api.gold-api.com/price/XAU");
    if (!r.ok) return null;
    const j = (await r.json()) as { price?: number; updatedAt?: string };
    if (typeof j.price !== "number" || !isFinite(j.price)) return null;
    return {
      price: j.price,
      timestamp: j.updatedAt ? new Date(j.updatedAt).getTime() : Date.now(),
      source: "gold-api",
    };
  } catch {
    return null;
  }
}

async function fetchStooq(): Promise<SpotPrice | null> {
  try {
    const r = await fetchWithTimeout(
      "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlc&h&e=csv",
      { headers: { "User-Agent": "Mozilla/5.0" } },
    );
    if (!r.ok) return null;
    const text = await r.text();
    // CSV: Symbol,Date,Time,Open,High,Low,Close
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const cols = lines[1].split(",");
    const close = parseFloat(cols[6]);
    if (!isFinite(close) || close <= 0) return null;
    return { price: close, timestamp: Date.now(), source: "stooq" };
  } catch {
    return null;
  }
}

/**
 * Returns the latest XAU/USD spot price.
 * Cached for 5s to avoid hammering external APIs.
 * Returns null if every source fails.
 */
export async function getSpotPrice(): Promise<SpotPrice | null> {
  if (cached && Date.now() < cacheExpiry) return cached;

  const primary = await fetchGoldApi();
  if (primary) {
    cached = primary;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return primary;
  }

  const fallback = await fetchStooq();
  if (fallback) {
    cached = fallback;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return fallback;
  }

  // All sources failed — return last cached value if any
  return cached;
}
