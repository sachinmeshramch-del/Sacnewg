import { useLivePrice } from "@/hooks/use-trading";
import { useLiveTick } from "@/hooks/use-tick";
import { ArrowUpRight, ArrowDownRight, TrendingUp, Minus, Radio } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

export function LivePriceBar() {
  const { data: priceData, isLoading } = useLivePrice();
  const { tick, direction } = useLiveTick();
  const [flash, setFlash] = useState(false);

  // Flash animation when tick price changes
  useEffect(() => {
    if (!tick) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 300);
    return () => clearTimeout(t);
  }, [tick?.price]);

  if (isLoading && !tick) {
    return (
      <div className="w-full h-24 rounded-2xl border border-white/5 bg-card/50 backdrop-blur-sm animate-pulse" />
    );
  }

  // Prefer live tick price, fall back to REST price data
  const displayPrice = tick?.price ?? priceData?.price ?? 0;
  const displayTimestamp = tick?.timestamp ?? priceData?.timestamp ?? new Date().toISOString();
  const isLive = !!tick;

  // For change / high / low, use the REST data which has full context
  const change = priceData?.change ?? 0;
  const changePercent = priceData?.changePercent ?? 0;
  const high24h = priceData?.high24h ?? 0;
  const low24h = priceData?.low24h ?? 0;

  const isPositive = direction === "up" || (direction === "flat" && change >= 0);
  const isNeutral = direction === "flat" && change === 0;

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-card overflow-hidden relative shadow-2xl shadow-black/50">
      {/* Decorative gradient */}
      <div className={cn(
        "absolute inset-0 opacity-[0.03] bg-gradient-to-r transition-colors duration-300",
        isPositive ? "from-success via-transparent to-transparent" : "from-destructive via-transparent to-transparent"
      )} />

      <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between p-6 gap-6">

        {/* Main Price */}
        <div className="flex items-center gap-6">
          <div className="flex flex-col">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> XAU/USD
              {isLive && (
                <span className="flex items-center gap-1 text-success ml-2">
                  <Radio className="h-3 w-3 animate-pulse" />
                  <span className="text-[10px] font-medium">LIVE</span>
                </span>
              )}
            </span>
            <div className="flex items-baseline gap-3">
              <span className={cn(
                "text-4xl md:text-5xl font-bold font-numbers tracking-tight transition-colors duration-200",
                flash && direction === "up" ? "text-success" :
                flash && direction === "down" ? "text-destructive" :
                "text-foreground"
              )}>
                ${displayPrice.toFixed(2)}
              </span>
              <div className={cn(
                "flex items-center gap-1 text-sm md:text-base font-medium px-2.5 py-1 rounded-lg border",
                isNeutral
                  ? "text-muted-foreground border-white/10 bg-white/5"
                  : isPositive
                    ? "text-success border-success/20 bg-success/10 shadow-[0_0_15px_rgba(22,163,74,0.15)]"
                    : "text-destructive border-destructive/20 bg-destructive/10 shadow-[0_0_15px_rgba(225,29,72,0.15)]"
              )}>
                {isNeutral ? <Minus className="h-4 w-4" /> : isPositive ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                <span className="font-numbers">{Math.abs(change).toFixed(2)} ({Math.abs(changePercent).toFixed(2)}%)</span>
              </div>
            </div>
          </div>
        </div>

        {/* 24h Stats */}
        <div className="flex gap-8 md:gap-12 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground mb-1">24h High</span>
            <span className="text-lg font-numbers font-medium text-foreground">${high24h.toFixed(2)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground mb-1">24h Low</span>
            <span className="text-lg font-numbers font-medium text-foreground">${low24h.toFixed(2)}</span>
          </div>
          <div className="flex flex-col border-l border-white/10 pl-8 md:pl-12">
            <span className="text-xs font-medium text-muted-foreground mb-1">
              {isLive ? "Tick Time" : "Last Updated"}
            </span>
            <span className="text-sm font-numbers font-medium text-foreground/70 mt-0.5">
              {format(new Date(displayTimestamp), "HH:mm:ss")}
            </span>
          </div>
        </div>

      </div>
    </div>
  );
}
