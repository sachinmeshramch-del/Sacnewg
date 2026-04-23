import { Router, type IRouter } from "express";
import { getIntradayPrice, getIntradaySignal, getIntradayHistory } from "../services/intradayService.js";

const router: IRouter = Router();

router.get("/intraday/price", async (_req, res) => {
  try {
    res.json(await getIntradayPrice());
  } catch (err) {
    console.error("Intraday price error:", err);
    res.status(500).json({ error: "Failed to fetch price" });
  }
});

router.get("/intraday/signal", async (req, res) => {
  try {
    const timeframe = (req.query.timeframe as string) || "15m";
    const signal = await getIntradaySignal(timeframe);
    res.json(signal);
  } catch (err) {
    console.error("Intraday signal error:", err);
    res.status(500).json({ error: "Failed to generate signal" });
  }
});

router.get("/intraday/history", (_req, res) => {
  try {
    res.json(getIntradayHistory());
  } catch (err) {
    console.error("Intraday history error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

export default router;
