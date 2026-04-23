import { useEffect, useRef, useState, memo } from "react";
import { createChart, CandlestickSeries, CrosshairMode, ColorType } from "lightweight-charts";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { Card } from "@/components/ui/card";
import { useLiveTick } from "@/hooks/use-tick";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Props {
  timeframe: "1m" | "5m";
}

export const CandlestickChart = memo(function CandlestickChart({ timeframe }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const { tick } = useLiveTick();

  // Init chart and load candle data
  useEffect(() => {
    if (!containerRef.current) return;
    setStatus("loading");
    let cancelled = false;

    // Destroy previous chart if any
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const el = containerRef.current;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#0A0A0F" },
        textColor: "rgba(255,255,255,0.6)",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#1a1a2e" },
        horzLine: { color: "rgba(255,255,255,0.2)", labelBackgroundColor: "#1a1a2e" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
        textColor: "rgba(255,255,255,0.5)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: timeframe === "1m",
        rightOffset: 5,
      },
      width: el.clientWidth || 800,
      height: el.clientHeight || 500,
    });

    chartRef.current = chart;

    // v5 API: addSeries(SeriesType, options)
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#e11d48",
      borderUpColor: "#16a34a",
      borderDownColor: "#e11d48",
      wickUpColor: "#4ade80",
      wickDownColor: "#fb7185",
    });
    seriesRef.current = series;

    // Fetch OHLC data
    fetch(`/api/candles?timeframe=${timeframe}`)
      .then(r => r.json())
      .then((body: { candles: Candle[] }) => {
        if (cancelled) return;
        if (!body.candles || body.candles.length === 0) {
          setStatus("error");
          return;
        }
        series.setData(
          body.candles.map(c => ({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );
        chart.timeScale().fitContent();
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    // Responsive resize
    const ro = new ResizeObserver(() => {
      if (chartRef.current && el) {
        chartRef.current.applyOptions({
          width: el.clientWidth,
          height: el.clientHeight,
        });
      }
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [timeframe]);

  // Update current candle close price with each tick
  useEffect(() => {
    if (!tick || !seriesRef.current) return;
    const tfSecs = timeframe === "1m" ? 60 : 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const candleTime = (Math.floor(nowSec / tfSecs) * tfSecs) as Time;
    try {
      seriesRef.current.update({
        time: candleTime,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      });
    } catch {
      // ignore if chart is being reset
    }
  }, [tick?.price]);

  return (
    <Card className="border-white/10 bg-[#0A0A0F] overflow-hidden w-full h-full min-h-[500px] relative flex flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">XAU/USD</span>
          <span className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-muted-foreground font-mono">
            {timeframe}
          </span>
        </div>
        {tick && (
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            <span className="text-xs text-success font-mono font-medium">${tick.price.toFixed(2)}</span>
            <span className="text-[10px] text-muted-foreground/60 uppercase">live</span>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="relative flex-1 min-h-[450px]">
        <div ref={containerRef} className="absolute inset-0" />

        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0A0A0F]/90 z-10 gap-3">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
            <p className="text-xs text-muted-foreground">Loading candles…</p>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0A0A0F] z-10 gap-2">
            <p className="text-sm text-muted-foreground">Chart data unavailable</p>
            <p className="text-xs text-muted-foreground/50">Market may be closed or still loading</p>
          </div>
        )}
      </div>
    </Card>
  );
});
