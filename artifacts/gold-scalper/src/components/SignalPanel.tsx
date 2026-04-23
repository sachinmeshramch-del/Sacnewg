import { useEffect, useRef } from "react";
import { useCurrentSignal } from "@/hooks/use-trading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Target, ShieldAlert, Coins, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface SignalPanelProps {
  timeframe: "1m" | "5m";
  onTimeframeChange: (t: "1m" | "5m") => void;
}

function playSignalSound(type: "BUY" | "SELL") {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const notes = type === "BUY"
      ? [440, 550, 660]  // ascending — bullish chime
      : [660, 550, 440]; // descending — bearish chime

    notes.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type      = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.25);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime  + i * 0.12 + 0.25);
    });
  } catch { /* AudioContext not available */ }
}

export function SignalPanel({ timeframe, onTimeframeChange }: SignalPanelProps) {
  const { data, isLoading, isError, isFetching } = useCurrentSignal(timeframe);
  const lastSignalRef = useRef<string | null>(null);

  // Sound + browser notification ONLY on confirmed (tradable) BUY/SELL signal
  useEffect(() => {
    if (!data || data.signal === "HOLD") return;
    if (data.signalStatus !== "CONFIRMED") return;
    const key = `${data.signal}-${data.timestamp}`;
    if (key === lastSignalRef.current) return;
    lastSignalRef.current = key;
    playSignalSound(data.signal as "BUY" | "SELL");

    // Browser notification if permitted
    if (Notification.permission === "granted") {
      new Notification(`🔔 XAUUSD ${data.signal} Signal Confirmed`, {
        body: `Entry $${data.entry} | SL $${data.stopLoss} | TP $${data.takeProfit} | ${data.confidence}% confidence`,
        icon: "/favicon.ico",
      });
    }
  }, [data]);

  // Request notification permission once on mount
  useEffect(() => {
    if (Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const getSignalColors = (signal?: string) => {
    switch (signal) {
      case "BUY":  return "bg-success text-success-foreground shadow-[0_0_24px_rgba(22,163,74,0.35)] border-success/50";
      case "SELL": return "bg-destructive text-destructive-foreground shadow-[0_0_24px_rgba(225,29,72,0.35)] border-destructive/50";
      default:     return "bg-warning/80 text-warning-foreground shadow-[0_0_24px_rgba(245,158,11,0.25)] border-warning/50";
    }
  };

  const getMarketModeStyle = (mode?: string) => {
    if (mode === "TRENDING") return "text-primary border-primary/30 bg-primary/10";
    if (mode === "SIDEWAYS") return "text-warning border-warning/30 bg-warning/10";
    return "text-muted-foreground border-white/10 bg-white/5";
  };

  const getTrendIcon = (trend?: string) => {
    if (trend === "BULLISH") return <TrendingUpIcon className="text-success" />;
    if (trend === "BEARISH") return <TrendingDownIcon className="text-destructive" />;
    return <MinusIcon className="text-warning" />;
  };

  return (
    <Card className="relative overflow-hidden border-white/10 bg-card/80 backdrop-blur-xl">
      {data?.signal === "BUY"  && <div className="absolute top-0 right-0 w-64 h-64 bg-success/10    blur-[100px] pointer-events-none rounded-full" />}
      {data?.signal === "SELL" && <div className="absolute top-0 right-0 w-64 h-64 bg-destructive/10 blur-[100px] pointer-events-none rounded-full" />}

      <CardHeader className="pb-4 flex flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg border border-primary/20">
            <CpuIcon className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-lg">AI Engine Signal</CardTitle>
        </div>

        <div className="flex items-center gap-1 bg-secondary p-1 rounded-lg border border-white/5">
          {(["1m", "5m"] as const).map(tf => (
            <Button
              key={tf}
              variant={timeframe === tf ? "default" : "ghost"}
              size="sm"
              className={cn("h-7 px-3 text-xs", timeframe !== tf && "text-muted-foreground")}
              onClick={() => onTimeframeChange(tf)}
            >
              {tf}
            </Button>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {isLoading || !data ? (
          <div className="space-y-6 animate-pulse">
            <div className="h-16 bg-white/5 rounded-xl" />
            <div className="h-4 bg-white/5 rounded-full w-3/4" />
            <div className="grid grid-cols-3 gap-4">
              {[1,2,3].map(i => <div key={i} className="h-20 bg-white/5 rounded-xl" />)}
            </div>
          </div>
        ) : isError ? (
          <div className="py-8 text-center text-destructive">Failed to load signal data.</div>
        ) : (
          <div className="space-y-6">

            {/* Market Mode Badge */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Market Mode:</span>
              <span className={cn(
                "text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border",
                getMarketModeStyle(data.marketMode)
              )}>
                {data.marketMode ?? "TRENDING"}
              </span>
              {data.marketMode === "SIDEWAYS" && (
                <span className="text-[10px] text-warning/80">RSI + MACD signals</span>
              )}
            </div>

            {/* Main Signal Badge */}
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-secondary/50 border border-white/5">
              <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-3">
                {data.signalStatus === "PENDING" ? "Awaiting Confirmation" : "Action Required"}
              </span>
              <div className={cn(
                "px-8 py-3 rounded-xl font-black text-3xl tracking-widest border",
                getSignalColors(data.signal),
                data.signalStatus === "PENDING" && data.signal !== "HOLD" && "opacity-70 ring-2 ring-warning/40 animate-pulse"
              )}>
                {data.signal}
              </div>

              {/* Status + Type badges */}
              {data.signal !== "HOLD" && (data.signalStatus || data.signalType) && (
                <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
                  {data.signalStatus && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border inline-flex items-center gap-1",
                      data.signalStatus === "CONFIRMED"
                        ? "text-success border-success/40 bg-success/10"
                        : "text-warning border-warning/40 bg-warning/10"
                    )}>
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        data.signalStatus === "CONFIRMED" ? "bg-success" : "bg-warning animate-pulse"
                      )} />
                      {data.signalStatus}
                    </span>
                  )}
                  {data.signalType && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border",
                      data.signalType === "TREND"
                        ? "text-primary border-primary/30 bg-primary/10"
                        : "text-warning border-warning/30 bg-warning/10"
                    )}>
                      {data.signalType === "TREND" ? "TREND TRADE" : "REVERSAL TRADE"}
                    </span>
                  )}
                </div>
              )}

              {/* Signal Label */}
              {data.signalLabel && data.signal !== "HOLD" && (
                <div className="mt-2 text-[10px] text-muted-foreground tracking-wide">
                  {data.signalLabel}
                </div>
              )}

              <div className="mt-5 w-full max-w-xs space-y-2">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-muted-foreground">AI Confidence</span>
                  <span className={cn(
                    "font-numbers",
                    data.confidence > 80 ? "text-success" : data.confidence > 60 ? "text-warning" : "text-destructive"
                  )}>
                    {data.confidence.toFixed(1)}%
                  </span>
                </div>
                <Progress value={data.confidence} className="h-1.5" />
              </div>
            </div>

            {/* Trade Parameters */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <Target className="h-4 w-4 text-blue-400 mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">Entry</span>
                <span className="font-numbers font-bold text-foreground text-sm">
                  {data.entry ? `$${data.entry.toFixed(2)}` : "N/A"}
                </span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <ShieldAlert className="h-4 w-4 text-destructive mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">Stop Loss</span>
                <span className="font-numbers font-bold text-destructive text-sm">
                  {data.stopLoss ? `$${data.stopLoss.toFixed(2)}` : "N/A"}
                </span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <Coins className="h-4 w-4 text-success mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">Take Profit</span>
                <span className="font-numbers font-bold text-success text-sm">
                  {data.takeProfit ? `$${data.takeProfit.toFixed(2)}` : "N/A"}
                </span>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-3 border-t border-white/5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Trend:</span>
                <Badge variant="outline" className="bg-white/5 text-xs font-semibold gap-1 py-0.5">
                  {getTrendIcon(data.trend)} {data.trend}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
                <span className="font-numbers">{format(new Date(data.timestamp), "HH:mm:ss")}</span>
              </div>
            </div>

          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TrendingUpIcon(props: any)   { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>; }
function TrendingDownIcon(props: any) { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>; }
function MinusIcon(props: any)        { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function CpuIcon(props: any)          { return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>; }
