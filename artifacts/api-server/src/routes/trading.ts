import { Router, type IRouter } from "express";
import { getLivePrice, getSignal, getHistory } from "../services/goldService.js";
import { getFinnhubPrice, isFinnhubConnected } from "../services/finnhubService.js";
import { getSpotPrice } from "../services/spotGoldService.js";
import { setTelegramConfig, getTelegramConfig, sendTelegramAlert } from "../services/telegramService.js";

const router: IRouter = Router();

router.get("/price", async (_req, res) => {
  try {
    const data = await getLivePrice();
    res.json(data);
  } catch (err) {
    console.error("Price error:", err);
    res.status(500).json({ error: "Failed to fetch price" });
  }
});

router.get("/signal", async (req, res) => {
  try {
    const timeframe = (req.query.timeframe as string) || "5m";
    const signal = await getSignal(timeframe);

    if (signal.signal !== "HOLD" && signal.signalStatus === "CONFIRMED") {
      sendTelegramAlert(
        signal.signal as "BUY" | "SELL",
        signal.entry,
        signal.stopLoss,
        signal.takeProfit,
        signal.confidence
      ).catch(console.error);
    }

    res.json(signal);
  } catch (err) {
    console.error("Signal error:", err);
    res.status(500).json({ error: "Failed to generate signal" });
  }
});

router.get("/history", (_req, res) => {
  try {
    const data = getHistory();
    res.json(data);
  } catch (err) {
    console.error("History error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

router.post("/telegram/configure", (req, res) => {
  const { botToken, chatId } = req.body;
  if (!botToken || !chatId) {
    res.status(400).json({ success: false, message: "botToken and chatId are required" });
    return;
  }
  setTelegramConfig({ botToken, chatId });
  res.json({ success: true, message: "Telegram alerts configured successfully" });
});

router.get("/telegram/status", (_req, res) => {
  const config = getTelegramConfig();
  res.json({
    configured: config !== null,
    chatId: config?.chatId ?? null,
  });
});

router.get("/status", (_req, res) => {
  res.json({
    finnhubConnected: isFinnhubConnected(),
    priceSource: isFinnhubConnected() ? "finnhub-websocket" : "yahoo-finance",
  });
});

// OHLC candle data for the chart
let candleCache5m: { data: unknown; expiry: number } | null = null;
let candleCache1m: { data: unknown; expiry: number } | null = null;

router.get("/candles", async (req, res) => {
  try {
    const timeframe = (req.query.timeframe as string) || "5m";
    const is1m = timeframe === "1m";
    const cache = is1m ? candleCache1m : candleCache5m;

    if (cache && Date.now() < cache.expiry) {
      res.json(cache.data);
      return;
    }

    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch })) as any;
    const interval = is1m ? "1m" : "5m";
    const range = is1m ? "2h" : "2d";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}&includePrePost=false`;

    const resp = await globalThis.fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    if (!resp.ok) throw new Error("Yahoo fetch failed");
    const raw = await resp.json() as any;
    const chart = raw?.chart?.result?.[0];
    if (!chart) throw new Error("No chart data");

    const timestamps: number[] = chart.timestamp;
    const quote = chart.indicators?.quote?.[0];
    const candles = timestamps.map((t: number, i: number) => ({
      time: t,
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
    })).filter((c: any) => c.open != null && c.high != null && c.low != null && c.close != null);

    const result = { candles, timeframe };
    if (is1m) {
      candleCache1m = { data: result, expiry: Date.now() + 30000 };
    } else {
      candleCache5m = { data: result, expiry: Date.now() + 60000 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch candles" });
  }
});

// Ultra-fast tick endpoint — no caching, returns Finnhub price instantly
router.get("/tick", async (_req, res) => {
  try {
    const finnhub = getFinnhubPrice();
    if (finnhub) {
      res.json({
        price: parseFloat(finnhub.price.toFixed(2)),
        source: "finnhub",
        timestamp: new Date(finnhub.timestamp).toISOString(),
      });
      return;
    }
    // Try spot-price feed (gold-api / stooq) so the tick matches TradingView OANDA
    const spot = await getSpotPrice();
    if (spot) {
      res.json({
        price: parseFloat(spot.price.toFixed(2)),
        source: spot.source,
        timestamp: new Date(spot.timestamp).toISOString(),
      });
      return;
    }
    // Last resort: cached price data (may be Yahoo futures)
    const priceData = await getLivePrice();
    res.json({
      price: priceData.price,
      source: priceData.source ?? "yahoo",
      timestamp: priceData.timestamp,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tick" });
  }
});

export default router;
