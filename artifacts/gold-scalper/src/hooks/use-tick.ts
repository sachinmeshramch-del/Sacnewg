import { useState, useEffect, useRef } from "react";

export interface TickData {
  price: number;
  source: "finnhub" | "yahoo" | "fallback";
  timestamp: string;
}

/**
 * Polls /api/trading/tick every 2 seconds for tick-by-tick price updates.
 * Falls back gracefully if the endpoint is unavailable.
 */
export function useLiveTick() {
  const [tick, setTick] = useState<TickData | null>(null);
  const [error, setError] = useState(false);
  const prevPriceRef = useRef<number | null>(null);
  const [direction, setDirection] = useState<"up" | "down" | "flat">("flat");

  useEffect(() => {
    let cancelled = false;

    const fetchTick = async () => {
      try {
        const resp = await fetch("/api/tick");
        if (!resp.ok) throw new Error("non-ok");
        const data: TickData = await resp.json();
        if (cancelled) return;

        setError(false);
        setTick(prev => {
          const prevPrice = prev?.price ?? null;
          if (prevPrice !== null && data.price !== prevPrice) {
            setDirection(data.price > prevPrice ? "up" : "down");
          } else if (prevPrice === null) {
            setDirection("flat");
          }
          prevPriceRef.current = data.price;
          return data;
        });
      } catch {
        if (!cancelled) setError(true);
      }
    };

    fetchTick();
    const interval = setInterval(fetchTick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { tick, error, direction };
}
