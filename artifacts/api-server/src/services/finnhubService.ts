import WebSocket from "ws";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? "";
const GOLD_SYMBOL = "OANDA:XAU_USD";
const WS_URL = `wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`;

// Exponential backoff config
const MIN_RECONNECT_MS = 15_000;   // 15 seconds minimum
const MAX_RECONNECT_MS = 300_000;  // 5 minutes maximum
let reconnectDelay = MIN_RECONNECT_MS;

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

let latestPrice: LivePrice | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;

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
    reconnectDelay = MIN_RECONNECT_MS; // reset backoff on success
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
    // 429 = rate limited; back off more aggressively
    const is429 = err.message.includes("429");
    if (is429) {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    }
    console.error(`[Finnhub] WebSocket error: ${err.message}. Next retry in ${Math.round(reconnectDelay / 1000)}s.`);
    ws?.terminate();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Increase delay for next attempt (exponential backoff, cap at max)
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_MS);
    connect();
  }, reconnectDelay);
}

// Start connection immediately when this module is loaded
connect();

// Send ping every 30s to keep connection alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30000);

/**
 * Returns the latest gold price from Finnhub WebSocket,
 * or null if no price has arrived yet.
 */
export function getFinnhubPrice(): LivePrice | null {
  if (!latestPrice) return null;
  // Consider price stale if older than 2 minutes
  const ageMs = Date.now() - latestPrice.timestamp;
  if (ageMs > 2 * 60 * 1000) return null;
  return latestPrice;
}

export function isFinnhubConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
