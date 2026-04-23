import { Router } from "express";
import {
  getSmcPrice,
  getSmcSignal,
  getSmcHistory,
  getSmcZones,
} from "../services/smcService.js";

const smcRouter = Router();

smcRouter.get("/smc/price", async (_req, res) => {
  try {
    const data = await getSmcPrice();
    res.json(data);
  } catch (err) {
    console.error("SMC price error:", err);
    res.status(500).json({ error: "Failed to fetch SMC price" });
  }
});

smcRouter.get("/smc/signal", async (req, res) => {
  try {
    const timeframe = (req.query.timeframe as "15m" | "1h") ?? "15m";
    const data = await getSmcSignal(timeframe);
    res.json(data);
  } catch (err) {
    console.error("SMC signal error:", err);
    res.status(500).json({ error: "Failed to generate SMC signal" });
  }
});

smcRouter.get("/smc/history", async (_req, res) => {
  try {
    const data = await getSmcHistory();
    res.json(data);
  } catch (err) {
    console.error("SMC history error:", err);
    res.status(500).json({ error: "Failed to fetch SMC history" });
  }
});

smcRouter.get("/smc/zones", async (_req, res) => {
  try {
    const data = await getSmcZones();
    res.json(data);
  } catch (err) {
    console.error("SMC zones error:", err);
    res.status(500).json({ error: "Failed to fetch SMC zones" });
  }
});

export default smcRouter;
