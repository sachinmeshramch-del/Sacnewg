import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tradingRouter from "./trading.js";
import intradayRouter from "./intraday.js";
import smcRouter from "./smc.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tradingRouter);
router.use(intradayRouter);
router.use(smcRouter);

export default router;
