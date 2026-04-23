import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface IndicatorsPanelProps {
  indicators?: {
    rsi: number;
    ema20: number;
    ema50: number;
    macdLine: number;
    macdSignal: number;
    macdHistogram: number;
    atr: number;
  };
  marketMode?: "TRENDING" | "SIDEWAYS";
  isLoading: boolean;
}

export function IndicatorsPanel({ indicators, marketMode, isLoading }: IndicatorsPanelProps) {

  const getRsiColor = (rsi: number) => {
    if (rsi < 30) return "text-success";
    if (rsi > 70) return "text-destructive";
    if (rsi < 50) return "text-success/70";
    if (rsi > 50) return "text-destructive/70";
    return "text-warning";
  };

  const getRsiLabel = (rsi: number) => {
    if (rsi < 30) return "OVERSOLD";
    if (rsi > 70) return "OVERBOUGHT";
    if (rsi >= 50 && rsi <= 65) return "BUY ZONE";
    if (rsi >= 35 && rsi <= 50) return "SELL ZONE";
    return "NEUTRAL";
  };

  const getMacdColor = (hist: number) => hist > 0 ? "text-success" : "text-destructive";

  const getAtrLabel = (atr: number, price: number) => {
    const pct = atr / price;
    if (pct < 0.0006) return { label: "VERY LOW", color: "text-muted-foreground" };
    if (pct > 0.007)  return { label: "SPIKE", color: "text-destructive" };
    if (pct > 0.003)  return { label: "HIGH", color: "text-warning" };
    return { label: "NORMAL", color: "text-success" };
  };

  const emaCross = indicators ? (indicators.ema20 > indicators.ema50 ? "BULLISH" : "BEARISH") : null;

  return (
    <Card className="border-white/10 bg-card/80 backdrop-blur-xl h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium text-muted-foreground">Technical Indicators</CardTitle>
          </div>
          {marketMode && (
            <span className={cn(
              "text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border",
              marketMode === "TRENDING"
                ? "text-primary border-primary/30 bg-primary/10"
                : "text-warning border-warning/30 bg-warning/10"
            )}>
              {marketMode}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || !indicators ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
            {[1,2,3,4].map(i => <div key={i} className="h-16 bg-white/5 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">

            {/* RSI */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col justify-between">
              <span className="text-[10px] text-muted-foreground font-semibold tracking-wider">RSI (14)</span>
              <div className="mt-2 flex items-baseline justify-between">
                <span className={cn("text-xl font-bold font-numbers", getRsiColor(indicators.rsi))}>
                  {indicators.rsi.toFixed(1)}
                </span>
                <span className={cn("text-[9px] font-semibold", getRsiColor(indicators.rsi))}>
                  {getRsiLabel(indicators.rsi)}
                </span>
              </div>
            </div>

            {/* EMA 20 / 50 */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground font-semibold tracking-wider">EMA 20/50</span>
                <span className={cn("text-[9px] font-bold", emaCross === "BULLISH" ? "text-success" : "text-destructive")}>
                  {emaCross}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-0.5">
                <div className="flex justify-between items-center text-sm font-numbers">
                  <span className="text-primary/70 text-[10px]">EMA20</span>
                  <span className="text-xs">{indicators.ema20.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm font-numbers text-muted-foreground">
                  <span className="text-[10px]">EMA50</span>
                  <span className="text-xs">{indicators.ema50.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* MACD */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col justify-between">
              <span className="text-[10px] text-muted-foreground font-semibold tracking-wider">MACD (12,26,9)</span>
              <div className="mt-2 flex flex-col gap-0.5">
                <div className="flex justify-between items-center text-sm font-numbers">
                  <span className="text-[10px] text-muted-foreground">Line</span>
                  <span className={cn("text-xs", getMacdColor(indicators.macdLine))}>{indicators.macdLine.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm font-numbers">
                  <span className="text-[10px] text-muted-foreground">Hist</span>
                  <span className={cn("text-xs font-bold", getMacdColor(indicators.macdHistogram))}>
                    {indicators.macdHistogram > 0 ? "▲" : "▼"} {Math.abs(indicators.macdHistogram).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* ATR */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex flex-col justify-between">
              <span className="text-[10px] text-muted-foreground font-semibold tracking-wider">ATR (14) Volatility</span>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-xl font-bold font-numbers text-foreground">
                  {indicators.atr.toFixed(2)}
                </span>
                {(() => {
                  const { label, color } = getAtrLabel(indicators.atr, indicators.ema20 || 3000);
                  return <span className={cn("text-[9px] font-bold", color)}>{label}</span>;
                })()}
              </div>
            </div>

          </div>
        )}
      </CardContent>
    </Card>
  );
}
