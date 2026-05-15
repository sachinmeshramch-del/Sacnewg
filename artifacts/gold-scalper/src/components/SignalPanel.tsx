import { useEffect, useRef } from "react";
import { useCurrentSignal } from "@/hooks/use-trading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Target, ShieldAlert, Coins, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeIST } from "@/lib/time";

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

  // Sound + browser notification ONLY on confirmed (tradable) BUY/SELL signal.
  // SETUP / HOLD / EARLY entries don't fire alerts — they're informational.
  useEffect(() => {
    if (!data || data.signal !== "BUY" && data.signal !== "SELL") return;
    if (data.signalStatus !== "CONFIRMED") return;
    const key = `${data.signal}-${data.timestamp}`;
    if (key === lastSignalRef.current) return;
    lastSignalRef.current = key;
    playSignalSound(data.signal as "BUY" | "SELL");

    // Browser notification if permitted. Mobile Chrome forbids `new Notification()`
    // and requires the ServiceWorkerRegistration path — try SW first, then fall
    // back to the constructor on desktop, and silently ignore if neither works.
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      const title = `🔔 XAUUSD ${data.signal} Signal Confirmed`;
      const options: NotificationOptions = {
        body: `Entry $${data.entry} | SL $${data.stopLoss} | TP $${data.takeProfit} | ${data.confidence}% confidence`,
        icon: "/favicon.ico",
      };
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.getRegistration()
          .then(reg => {
            if (reg) {
              reg.showNotification(title, options).catch(() => {});
            } else {
              try { new Notification(title, options); } catch { /* mobile blocks ctor */ }
            }
          })
          .catch(() => {
            try { new Notification(title, options); } catch { /* ignore */ }
          });
      } else {
        try { new Notification(title, options); } catch { /* ignore */ }
      }
    }
  }, [data]);

  // Request notification permission once on mount (skip on browsers without API)
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const getSignalColors = (signal?: string) => {
    switch (signal) {
      case "BUY":   return "bg-success text-success-foreground shadow-[0_0_24px_rgba(22,163,74,0.35)] border-success/50";
      case "SELL":  return "bg-destructive text-destructive-foreground shadow-[0_0_24px_rgba(225,29,72,0.35)] border-destructive/50";
      case "SETUP": return "bg-primary/80 text-primary-foreground shadow-[0_0_24px_rgba(59,130,246,0.30)] border-primary/50";
      default:      return "bg-warning/80 text-warning-foreground shadow-[0_0_24px_rgba(245,158,11,0.25)] border-warning/50";
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

  // Smart Trend Engine — fuse direction + strength into a single label.
  const getSmartTrendLabel = (trend?: string, strength?: string) => {
    if (!trend || trend === "NEUTRAL") return strength === "RANGE" ? "SIDEWAYS" : "NEUTRAL";
    if (strength === "STRONG") return `STRONG ${trend}`;
    if (strength === "WEAK")   return `WEAK ${trend} (Pullback)`;
    if (strength === "RANGE")  return "SIDEWAYS";
    return trend;
  };

  const getSmartTrendColors = (trend?: string, strength?: string) => {
    if (strength === "RANGE" || trend === "NEUTRAL")
      return "bg-muted/20 border-border/40 text-muted-foreground";
    const isStrong = strength === "STRONG";
    if (trend === "BULLISH") return isStrong
      ? "bg-success/15 border-success/50 text-success"
      : "bg-warning/10 border-warning/40 text-warning";
    if (trend === "BEARISH") return isStrong
      ? "bg-destructive/15 border-destructive/50 text-destructive"
      : "bg-warning/10 border-warning/40 text-warning";
    return "bg-white/5 border-white/10 text-foreground";
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
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">Market Mode:</span>
              <span className={cn(
                "text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border",
                getMarketModeStyle(data.marketMode)
              )}>
                {data.marketMode ?? "TRENDING"}
              </span>
              {(data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM") && (
                <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border border-amber-400/40 bg-amber-400/10 text-amber-300">
                  ⚡ STRONG TREND
                </span>
              )}
              {data.marketMode === "SIDEWAYS" && (
                <span className="text-[10px] text-warning/80">RSI + MACD signals</span>
              )}
            </div>

            {/* Session Status */}
            {(data as any).sessionName && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Session:</span>
                <span className={cn(
                  "text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border inline-flex items-center gap-1",
                  (data as any).sessionCode === "OVERLAP"
                    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
                    : (data as any).sessionActive
                      ? "border-success/40 bg-success/8 text-success/90"
                      : "border-amber-400/40 bg-amber-400/10 text-amber-200",
                )}>
                  <span className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    (data as any).sessionCode === "OVERLAP" ? "bg-emerald-400"
                    : (data as any).sessionActive            ? "bg-success"
                    :                                          "bg-amber-400",
                  )} />
                  {(data as any).sessionName}
                </span>
                {!(data as any).sessionActive && (
                  <span className="text-[9px] text-muted-foreground/50">low-volume session</span>
                )}
              </div>
            )}

            {/* Main Signal Badge */}
            <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-secondary/50 border border-white/5">
              <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-3">
                {data.signal === "SETUP"            ? "Trade Forming"
                  : data.signal === "HOLD"          ? (
                      data.signalStrength === "WEAK"   ? "Weak Setup"
                    : data.signalStrength === "NORMAL" ? "Moderate Setup"
                    : data.signalStrength === "STRONG" ? "Strong Setup"
                    :                                    "No Opportunity"
                    )
                  : data.signalStatus === "PENDING" ? "Awaiting Confirmation"
                  :                                   "Action Required"}
              </span>
              <div className={cn(
                "px-8 py-3 rounded-xl font-black text-3xl tracking-widest border",
                getSignalColors(data.signal),
                data.signalStatus === "PENDING" && (data.signal === "BUY" || data.signal === "SELL") && "opacity-70 ring-2 ring-warning/40 animate-pulse",
                data.signal === "SETUP" && "ring-2 ring-primary/40"
              )}>
                {data.signal}
              </div>

              {/* Permission + Market Regime — at-a-glance "should I act?" row.
                  Permission is the gate (ACTIONABLE/QUALIFIED show levels;
                  WATCHLIST/BLOCKED hide them). Regime is the "what kind of
                  market is this" tag. Both come from the new decision layer. */}
              {(data.permission || data.marketRegime || data.signalStrength) && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap justify-center">
                  {data.signalStrength && data.signalStrength !== "NONE" && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-black tracking-widest uppercase border",
                      data.signalStrength === "STRONG" && "border-success/60 bg-success/15 text-success",
                      data.signalStrength === "NORMAL" && "border-primary/60 bg-primary/15 text-primary",
                      data.signalStrength === "WEAK"   && "border-warning/50 bg-warning/10 text-warning",
                    )}>
                      {data.signalStrength} {typeof data.score === "number" && (
                        <span className="opacity-70 font-bold ml-0.5">({data.score})</span>
                      )}
                    </span>
                  )}
                  {data.permission && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-black tracking-widest uppercase border",
                      data.permission === "ACTIONABLE" && "border-success/60 bg-success/15 text-success",
                      data.permission === "QUALIFIED"  && "border-success/30 bg-success/8 text-success/90",
                      data.permission === "WATCHLIST"  && "border-warning/40 bg-warning/10 text-warning",
                      data.permission === "BLOCKED"    && "border-destructive/30 bg-destructive/10 text-destructive/90",
                    )}>
                      {data.permission}
                    </span>
                  )}
                  {data.marketRegime && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-bold tracking-widest uppercase border",
                      data.marketRegime === "TRENDING_BULL" && "border-success/40 bg-success/8 text-success/90",
                      data.marketRegime === "TRENDING_BEAR" && "border-destructive/40 bg-destructive/8 text-destructive/90",
                      data.marketRegime === "RANGING"       && "border-border/50 bg-card/60 text-muted-foreground",
                      data.marketRegime === "CHOPPY"        && "border-amber-400/50 bg-amber-400/10 text-amber-200",
                      data.marketRegime === "TRANSITION"    && "border-warning/40 bg-warning/10 text-warning",
                    )}>
                      {data.marketRegime.replace("_", " ")}
                    </span>
                  )}
                  {typeof data.chopScore === "number" && data.chopScore > 0.45 && (
                    <span className="px-2 py-0.5 rounded-md text-[9.5px] font-bold tracking-widest uppercase border border-amber-400/40 bg-amber-400/10 text-amber-200">
                      CHOP {Math.round(data.chopScore * 100)}
                    </span>
                  )}
                  {(data as any).marketPhase && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-bold tracking-widest uppercase border",
                      (data as any).marketPhase === "PULLBACK"   && "border-emerald-400/50 bg-emerald-400/10 text-emerald-300",
                      (data as any).marketPhase === "TRENDING"   && "border-success/40 bg-success/8 text-success/90",
                      (data as any).marketPhase === "CHOPPY"     && "border-amber-400/40 bg-amber-400/10 text-amber-200",
                      (data as any).marketPhase === "EXHAUSTION" && "border-destructive/40 bg-destructive/10 text-destructive/80",
                    )} title={(data as any).marketPhaseLabel ?? ""}>
                      {(data as any).marketPhase === "PULLBACK"   ? "⟳ PULLBACK"   :
                       (data as any).marketPhase === "TRENDING"   ? "▲ TRENDING"   :
                       (data as any).marketPhase === "CHOPPY"     ? "⊡ CHOPPY"     :
                       "⚠ EXHAUSTED"}
                    </span>
                  )}
                  {(data as any).signalGrade && (data.signal === "BUY" || data.signal === "SELL") && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-black tracking-widest uppercase border",
                      (data as any).signalGrade === "A+" && "border-emerald-400/60 bg-emerald-400/15 text-emerald-300",
                      (data as any).signalGrade === "A"  && "border-success/60 bg-success/15 text-success",
                      (data as any).signalGrade === "B"  && "border-primary/50 bg-primary/10 text-primary",
                      (data as any).signalGrade === "C"  && "border-warning/50 bg-warning/10 text-warning",
                      (data as any).signalGrade === "D"  && "border-destructive/40 bg-destructive/10 text-destructive/80",
                    )}>
                      GRADE {(data as any).signalGrade}
                    </span>
                  )}
                  {(data as any).entryQualityGrade && (data.signal === "BUY" || data.signal === "SELL") && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-md text-[9.5px] font-black tracking-widest uppercase border",
                      (data as any).entryQualityGrade === "A+" && "border-emerald-400/60 bg-emerald-400/15 text-emerald-300",
                      (data as any).entryQualityGrade === "A"  && "border-success/60 bg-success/15 text-success",
                      (data as any).entryQualityGrade === "B"  && "border-primary/50 bg-primary/10 text-primary",
                      (data as any).entryQualityGrade === "C"  && "border-warning/40 bg-warning/8 text-warning/90",
                      (data as any).entryQualityGrade === "D"  && "border-destructive/40 bg-destructive/10 text-destructive/70",
                    )}
                    title={(data as any).entryQualityLabel}>
                      EQ {(data as any).entryQualityGrade}
                      {typeof (data as any).entryQualityScore === "number" && (
                        <span className="opacity-60 font-bold ml-0.5">({(data as any).entryQualityScore})</span>
                      )}
                    </span>
                  )}
                </div>
              )}

              {/* Decision-layer banner — soft, descriptive ("Mixed indicators
                  — waiting for structure confirmation", "Choppy market", etc.).
                  Quietly placed so it informs without alarming. */}
              {data.bannerMessage && (
                <div className={cn(
                  "mt-2 px-3 py-2 rounded-md border text-[10.5px] tracking-wide max-w-[320px] text-center",
                  data.signal === "CONFLICT"
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                    : data.permission === "WATCHLIST"
                      ? "border-warning/40 bg-warning/10 text-warning"
                      : "border-border/40 bg-card/40 text-muted-foreground",
                )}>
                  {data.bannerMessage}
                </div>
              )}

              {/* Indicator conflict reasons (compact list) — shown when MIXED+ */}
              {data.conflictReasons && data.conflictReasons.length > 0 &&
                (data.conflictLevel === "MIXED" || data.conflictLevel === "SEVERE") && (
                <ul className="mt-2 max-w-[320px] space-y-0.5 text-[9.5px] text-muted-foreground/80">
                  {data.conflictReasons.slice(0, 3).map((r: string, i: number) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="text-amber-400/70 leading-none mt-[2px]">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Momentum Shift Detected — fires when RSI direction flips to align with the trade */}
              {data.momentumShiftDetected && (data.signal === "BUY" || data.signal === "SELL") && (
                <div className="mt-3 px-3 py-1.5 rounded-md border-2 border-emerald-400/60 bg-emerald-400/10 text-emerald-300 text-[11px] font-black tracking-widest uppercase flex items-center gap-1.5 shadow-[0_0_18px_rgba(52,211,153,0.25)] animate-pulse">
                  <span className="text-base leading-none">🚀</span>
                  MOMENTUM SHIFT DETECTED
                </div>
              )}

              {/* Trap / Stop-Hunt banner — highest priority alert */}
              {data.signal !== "HOLD" && data.signalLabel && (
                data.signalLabel.includes("FAKE BREAKOUT") ||
                data.signalLabel.includes("FAKE BREAKDOWN") ||
                data.signalLabel.includes("STOP HUNT")
              ) && (
                <div className="mt-3 px-3 py-1.5 rounded-md border-2 border-amber-400/60 bg-amber-400/10 text-amber-200 text-[11px] font-black tracking-widest uppercase flex items-center gap-1.5 shadow-[0_0_18px_rgba(251,191,36,0.25)]">
                  <span className="text-base leading-none">⚡</span>
                  {data.signalLabel.includes("STOP HUNT") ? "STOP HUNT DETECTED" : "FAKE BREAKOUT DETECTED"}
                </div>
              )}

              {/* Market State badge — TRENDING / EXHAUSTED / REVERSAL_WATCH */}
              {data.marketState && data.marketState !== "TRENDING" && (
                <div className={cn(
                  "mt-3 px-3 py-1.5 rounded-md border text-[11px] font-black tracking-widest uppercase inline-flex items-center gap-1.5",
                  data.marketState === "EXHAUSTED"
                    ? "border-warning/50 bg-warning/10 text-warning"
                    : "border-amber-400/50 bg-amber-400/10 text-amber-200"
                )}>
                  <span className="text-base leading-none">
                    {data.marketState === "EXHAUSTED" ? "💤" : "⚠"}
                  </span>
                  {data.marketState === "EXHAUSTED" ? "MOMENTUM EXHAUSTED" : "REVERSAL WATCH"}
                </div>
              )}

              {/* Active Warnings — All engine warning badges */}
              {(data as any).activeWarnings && (data as any).activeWarnings.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 justify-center">
                  {((data as any).activeWarnings as string[]).map((w: string, i: number) => (
                    <span key={i} className={cn(
                      "px-2 py-0.5 rounded-md text-[9px] font-black tracking-widest uppercase border inline-flex items-center gap-1",
                      (w === "REVERSAL RISK HIGH" || w === "STRUCTURE BLOCKED")
                                                        && "border-destructive/70 bg-destructive/15 text-destructive animate-pulse",
                      w === "MOMENTUM REVERSING"        && "border-destructive/55 bg-destructive/10 text-destructive/90",
                      w === "STRONG IMPULSE AGAINST"    && "border-destructive/45 bg-destructive/8 text-destructive/80",
                      w === "MACD WEAKENING"            && "border-warning/55 bg-warning/10 text-warning",
                      (w === "TREND EXHAUSTED" || w === "MOMENTUM EXHAUSTED")
                                                        && "border-warning/50 bg-warning/10 text-warning/90",
                      w === "MOMENTUM WEAKENING"        && "border-warning/40 bg-warning/8 text-warning/80",
                      w === "MOMENTUM TOO WEAK"         && "border-warning/50 bg-warning/10 text-warning/80",
                      (w === "REVERSAL STARTING" || w === "LIQUIDITY TRAP")
                                                        && "border-amber-400/55 bg-amber-400/10 text-amber-200",
                      (w === "CHOPPY MARKET" || w === "CHOPPY MARKET — NO TRADE")
                                                        && "border-muted/50 bg-muted/10 text-muted-foreground",
                      w === "RANGE COMPRESSION"         && "border-muted/40 bg-muted/8 text-muted-foreground/80",
                      w === "MOMENTUM DIVERGENCE"       && "border-orange-400/50 bg-orange-400/10 text-orange-200",
                      w === "MOVE EXTENDED"             && "border-red-500/70 bg-red-500/15 text-red-300 animate-pulse",
                      (w === "SUPPORT NEARBY" || w === "RESISTANCE NEARBY")
                                                        && "border-amber-500/60 bg-amber-500/10 text-amber-200",
                      w === "FRESH MOMENTUM"            && "border-emerald-400/60 bg-emerald-400/10 text-emerald-300",
                      (w === "WAITING FOR PULLBACK" || w === "WAITING FOR CONFIRMATION")
                                                        && "border-sky-400/55 bg-sky-400/10 text-sky-300",
                    )}>
                      <span className="text-[8px] leading-none">⚠</span>
                      {w}
                    </span>
                  ))}
                </div>
              )}

              {/* Structure Block Banner — fires when structure engine vetoes the signal */}
              {(data as any).structureBlockReason && (data.signal === "HOLD" || (data as any).activeWarnings?.includes("STRUCTURE BLOCKED")) && (
                <div className="mt-2 px-3 py-1.5 rounded-md border border-destructive/40 bg-destructive/8 text-destructive/90 text-[10px] font-bold tracking-wide max-w-[300px] text-center">
                  ⛔ {(data as any).structureBlockReason}
                </div>
              )}

              {/* Auto Trade Safety — prominent badge for safe vs blocked auto-trade */}
              {(data.signal === "BUY" || data.signal === "SELL") && (
                <div className={cn(
                  "mt-2 px-3 py-1 rounded-md border text-[9.5px] font-black tracking-widest uppercase inline-flex items-center gap-1.5",
                  (data as any).autoTradeSafe
                    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
                    : "border-destructive/40 bg-destructive/8 text-destructive/80",
                )}>
                  <span className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    (data as any).autoTradeSafe ? "bg-emerald-400" : "bg-destructive animate-pulse",
                  )} />
                  {(data as any).autoTradeSafe ? "AUTO TRADE SAFE" : "AUTO TRADE BLOCKED"}
                </div>
              )}

              {/* Multi-trade status banner — replaces old "BLOCKED" messaging */}
              {data.multiTradeStatus && (
                <div className={cn(
                  "mt-2 px-3 py-1.5 rounded-md border text-[10px] font-black tracking-widest uppercase max-w-[300px] text-center",
                  data.executionStatus === "LIMITED"
                    ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                    : data.executionStatus === "SKIPPED"
                      ? "border-warning/40 bg-warning/10 text-warning"
                      : "border-primary/30 bg-primary/10 text-primary",
                )}>
                  {data.multiTradeStatus}
                  {typeof data.activeTradeCount === "number" && data.activeTradeCount > 0 && (
                    <span className="ml-1.5 opacity-70">({data.activeTradeCount}/{3})</span>
                  )}
                </div>
              )}

              {/* Block reason — surfaces WHY a trade idea was suppressed (non-multi-trade) */}
              {data.blockReason && !data.multiTradeStatus && (
                <div className="mt-2 px-3 py-1.5 rounded-md border border-destructive/30 bg-destructive/10 text-destructive text-[10px] font-semibold tracking-wide uppercase max-w-[260px] text-center">
                  Blocked: {data.blockReason}
                </div>
              )}

              {/* Pullback confirmed signal banner — fires on PULLBACK BUY / SELL or WEAK PULLBACK */}
              {(data.pullbackStrength === "PULLBACK" || data.pullbackStrength === "WEAK_PULLBACK") &&
               (data.signal === "BUY" || data.signal === "SELL") && (
                <div className={cn(
                  "mt-3 px-3 py-1.5 rounded-md border-2 text-[11px] font-black tracking-widest uppercase inline-flex items-center gap-1.5",
                  data.pullbackStrength === "PULLBACK" && data.signal === "BUY"
                    ? "border-success/60 bg-success/10 text-success shadow-[0_0_18px_rgba(22,163,74,0.25)]"
                  : data.pullbackStrength === "PULLBACK" && data.signal === "SELL"
                    ? "border-destructive/60 bg-destructive/10 text-destructive shadow-[0_0_18px_rgba(225,29,72,0.25)]"
                  : "border-warning/60 bg-warning/10 text-warning"
                )}>
                  <span className="text-base leading-none">🎯</span>
                  {data.pullbackStrength === "PULLBACK"
                    ? (data.signal === "BUY" ? "PULLBACK BUY CONFIRMED" : "PULLBACK SELL CONFIRMED")
                    : (data.signal === "BUY" ? "WEAK PULLBACK BUY"      : "WEAK PULLBACK SELL")}
                </div>
              )}

              {/* Pullback State — live BULLISH_PULLBACK / BEARISH_PULLBACK detector */}
              {data.pullbackState && data.pullbackState !== "NONE" && (
                <div className={cn(
                  "mt-2 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border inline-flex items-center gap-1.5 uppercase",
                  data.pullbackState === "BULLISH_PULLBACK"
                    ? "border-success/40 bg-success/10 text-success"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                )}>
                  <span className={cn(
                    "h-1.5 w-1.5 rounded-full animate-pulse",
                    data.pullbackState === "BULLISH_PULLBACK" ? "bg-success" : "bg-destructive"
                  )} />
                  {data.pullbackState === "BULLISH_PULLBACK" ? "BULLISH PULLBACK" : "BEARISH PULLBACK"}
                </div>
              )}

              {/* Signal Analysis Panel — always visible when zone/confirmation data exists */}
              {(data.zoneStatus || data.pullbackConfirmation || data.entryMode || data.signalCategory) && (
                <div className="mt-3 w-full max-w-[260px] mx-auto rounded-md border border-border/40 bg-card/40 px-3 py-2 text-[10px] tracking-wide space-y-1.5">

                  {/* Row: Signal Type — MOMENTUM / PULLBACK / TREND / REVERSAL */}
                  {(data.signalCategory || data.signalType) && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Signal Type</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM") ? "text-amber-300" :
                        (data.signalCategory === "PULLBACK" || data.signalType === "PULLBACK")  ? "text-success" :
                        (data.signalCategory === "REVERSAL" || data.signalType === "REVERSAL")  ? "text-warning" :
                        "text-primary",
                      )}>
                        {(data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM") ? "⚡ MOMENTUM" :
                         (data.signalCategory === "PULLBACK" || data.signalType === "PULLBACK")  ? "↩ PULLBACK" :
                         (data.signalCategory === "REVERSAL" || data.signalType === "REVERSAL")  ? "↗ REVERSAL" :
                         "TREND"}
                      </span>
                    </div>
                  )}

                  {/* Row: Entry Mode — AUTO / CONFIRMED / WAITING */}
                  {data.entryMode && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Entry Mode</span>
                      <span className={cn(
                        "font-bold tracking-widest inline-flex items-center gap-1",
                        data.entryMode === "AUTO"      ? "text-amber-300" :
                        data.entryMode === "CONFIRMED" ? "text-success" : "text-warning",
                      )}>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          data.entryMode === "AUTO"      ? "bg-amber-400 animate-pulse" :
                          data.entryMode === "CONFIRMED" ? "bg-success" : "bg-warning animate-pulse",
                        )} />
                        {data.entryMode === "AUTO"      ? "AUTO — MOMENTUM" :
                         data.entryMode === "CONFIRMED" ? "CONFIRMED" : "WAITING"}
                      </span>
                    </div>
                  )}

                  {/* Row: Market Mode — STRONG TREND / TRENDING / SIDEWAYS */}
                  {data.marketMode && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Market Mode</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM") ? "text-amber-300" :
                        data.marketMode === "TRENDING" ? "text-primary" : "text-warning",
                      )}>
                        {(data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM")
                          ? "⚡ STRONG TREND"
                          : data.marketMode === "TRENDING" ? "TRENDING" : "SIDEWAYS"}
                      </span>
                    </div>
                  )}

                  {/* Row: Pullback Zone YES / NO */}
                  <div className="flex items-center justify-between pt-1 border-t border-border/30">
                    <span className="text-muted-foreground">Pullback Zone</span>
                    {data.zoneStatus && data.zoneStatus !== "NO_ZONE" ? (
                      <span className={cn(
                        "font-bold tracking-widest inline-flex items-center gap-1",
                        data.zoneStatus === "BUY_ZONE" ? "text-success" : "text-destructive",
                      )}>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full animate-pulse",
                          data.zoneStatus === "BUY_ZONE" ? "bg-success" : "bg-destructive",
                        )} />
                        YES — {data.zoneStatus === "BUY_ZONE" ? "BUY ZONE" : "SELL ZONE"}
                      </span>
                    ) : (
                      <span className="font-bold tracking-widest text-muted-foreground">NO</span>
                    )}
                  </div>

                  {/* Row: Confirmation WAITING / CONFIRMED */}
                  <div className="flex items-center justify-between pt-1 border-t border-border/30">
                    <span className="text-muted-foreground">Confirmation</span>
                    <span className={cn(
                      "font-bold tracking-widest inline-flex items-center gap-1",
                      (data.pullbackConfirmation === "REJECTION_DETECTED" || data.entryMode === "CONFIRMED" || data.entryMode === "AUTO")
                        ? "text-success" : "text-warning",
                    )}>
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        (data.pullbackConfirmation === "REJECTION_DETECTED" || data.entryMode === "CONFIRMED" || data.entryMode === "AUTO")
                          ? "bg-success" : "bg-warning animate-pulse",
                      )} />
                      {(data.pullbackConfirmation === "REJECTION_DETECTED" || data.entryMode === "CONFIRMED" || data.entryMode === "AUTO")
                        ? "CONFIRMED" : "WAITING"}
                    </span>
                  </div>

                  {/* Row: RSI Direction RISING / FALLING / FLAT */}
                  {data.rsiDirection && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">RSI Direction</span>
                      <span className={cn(
                        "font-bold tracking-widest inline-flex items-center gap-1",
                        data.rsiDirection === "RISING"  ? "text-success" :
                        data.rsiDirection === "FALLING" ? "text-destructive" : "text-muted-foreground",
                      )}>
                        {data.rsiDirection === "RISING"  ? "↑ RISING" :
                         data.rsiDirection === "FALLING" ? "↓ FALLING" : "→ FLAT"}
                      </span>
                    </div>
                  )}

                  {/* Row: Momentum Alignment — CONFIRMED / DELAYED / BLOCKED / WAITING */}
                  {data.momentumAlignmentStatus && (data.signal === "BUY" || data.signal === "SELL") && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Momentum</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px] inline-flex items-center gap-1",
                        data.momentumAlignmentStatus === "CONFIRMED" ? "text-success" :
                        data.momentumAlignmentStatus === "BLOCKED"   ? "text-destructive" :
                        data.momentumAlignmentStatus === "DELAYED"   ? "text-amber-300" :
                        "text-warning",
                      )}>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          data.momentumAlignmentStatus === "CONFIRMED" ? "bg-success" :
                          data.momentumAlignmentStatus === "BLOCKED"   ? "bg-destructive" :
                          "bg-amber-400 animate-pulse",
                        )} />
                        {data.momentumAlignmentStatus === "CONFIRMED" ? "✓ CONFIRMED" :
                         data.momentumAlignmentStatus === "BLOCKED"   ? "✗ BLOCKED" :
                         data.momentumAlignmentStatus === "DELAYED"   ? "⏳ WAITING FOR ALIGNMENT" :
                         "⏳ WAITING"}
                      </span>
                    </div>
                  )}

                  {/* Row: Signal Class */}
                  {data.pullbackStrength && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Signal Class</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        data.pullbackStrength === "STRONG_TREND"  ? "text-amber-300" :
                        data.pullbackStrength === "PULLBACK"      ? "text-success" :
                        data.pullbackStrength === "WEAK_PULLBACK" ? "text-warning" : "text-muted-foreground",
                      )}>
                        {data.pullbackStrength === "STRONG_TREND"  ? "⚡ STRONG MOMENTUM" :
                         data.pullbackStrength === "PULLBACK"      ? "✓ PULLBACK" :
                         data.pullbackStrength === "WEAK_PULLBACK" ? "WEAK PULLBACK" : "NO TRADE"}
                      </span>
                    </div>
                  )}

                  {/* Row: Trend State — 7-state advanced classifier */}
                  {(data as any).trendState && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Trend State</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data as any).trendState === "TRENDING_STRONG"   && "text-emerald-300",
                        (data as any).trendState === "TRENDING_WEAK"     && "text-success",
                        (data as any).trendState === "REVERSAL_STARTING" && "text-destructive",
                        (data as any).trendState === "CHOPPY"            && "text-amber-200",
                        (data as any).trendState === "EXHAUSTED_TREND"   && "text-warning",
                        (data as any).trendState === "BREAKOUT_BUILDUP"  && "text-primary",
                        (data as any).trendState === "LIQUIDITY_TRAP"    && "text-amber-300",
                      )}>
                        {((data as any).trendState as string).replace(/_/g, " ")}
                      </span>
                    </div>
                  )}

                  {/* Row: Reversal Risk — only shown when MEDIUM or HIGH */}
                  {(data as any).reversalRisk && (data as any).reversalRisk !== "LOW" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Reversal Risk</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px] inline-flex items-center gap-1",
                        (data as any).reversalRisk === "HIGH"   && "text-destructive",
                        (data as any).reversalRisk === "MEDIUM" && "text-warning",
                      )}>
                        {(data as any).reversalRisk === "HIGH" ? "⚠ HIGH" : "△ MEDIUM"}
                      </span>
                    </div>
                  )}

                  {/* Row: Market Structure */}
                  {(data as any).marketStructure && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Structure</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        ((data as any).marketStructure === "BOS_BULLISH" || (data as any).marketStructure === "CHOCH_BULLISH" || (data as any).marketStructure === "BULLISH_TRENDING") && "text-success",
                        ((data as any).marketStructure === "BOS_BEARISH" || (data as any).marketStructure === "CHOCH_BEARISH" || (data as any).marketStructure === "BEARISH_TRENDING") && "text-destructive",
                        (data as any).marketStructure === "LIQUIDITY_SWEEP" && "text-amber-300",
                        ((data as any).marketStructure === "CHOPPY" || (data as any).marketStructure === "RANGE_COMPRESSION") && "text-muted-foreground",
                      )}>
                        {((data as any).marketStructure as string).replace(/_/g, " ")}
                      </span>
                    </div>
                  )}

                  {/* Row: Structure Quality */}
                  {(data as any).structureQuality && (data as any).structureQuality !== "NONE" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Structure Quality</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data as any).structureQuality === "STRONG"   && "text-emerald-300",
                        (data as any).structureQuality === "MODERATE" && "text-success",
                        (data as any).structureQuality === "WEAK"     && "text-warning",
                      )}>
                        {(data as any).structureQuality}
                      </span>
                    </div>
                  )}

                  {/* Row: EMA Distance */}
                  {typeof (data as any).emaDistanceATR === "number" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">EMA Distance</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data as any).emaDistanceATR <= 0.8 ? "text-emerald-300"  :
                        (data as any).emaDistanceATR <= 1.5 ? "text-success"      :
                        (data as any).emaDistanceATR <= 2.0 ? "text-warning"      : "text-destructive/80",
                      )}>
                        {(data as any).emaDistanceATR}× ATR
                        {typeof (data as any).emaDistance === "number" && (
                          <span className="text-muted-foreground/50 ml-1 font-normal">
                            (${(data as any).emaDistance.toFixed(2)})
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Row: Pullback Quality */}
                  {(data as any).pullbackQuality && (data as any).pullbackQuality !== "NONE" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Pullback Quality</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data as any).pullbackQuality === "STRONG"   && "text-emerald-300",
                        (data as any).pullbackQuality === "MODERATE" && "text-success",
                        (data as any).pullbackQuality === "WEAK"     && "text-warning",
                      )}>
                        {(data as any).pullbackQuality === "STRONG"   ? "✓ STRONG PULLBACK"   :
                         (data as any).pullbackQuality === "MODERATE" ? "✓ MODERATE PULLBACK" :
                         "WEAK PULLBACK"}
                      </span>
                    </div>
                  )}

                  {/* Row: Momentum Quality Score — visual meter */}
                  {typeof (data as any).momentumQualityScore === "number" && (
                    <div className="pt-1 border-t border-border/30 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Momentum</span>
                        <span className={cn(
                          "font-bold tracking-widest text-[9px]",
                          (data as any).momentumQualityScore >= 80 && "text-emerald-300",
                          (data as any).momentumQualityScore >= 60 && (data as any).momentumQualityScore < 80 && "text-success",
                          (data as any).momentumQualityScore >= 40 && (data as any).momentumQualityScore < 60 && "text-warning",
                          (data as any).momentumQualityScore < 40  && "text-destructive/80",
                        )}>
                          {(data as any).momentumQualityScore}/100 · {((data as any).momentumQualityLabel as string ?? "").replace(/_/g, " ")}
                        </span>
                      </div>
                      <div className="w-full h-1 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            (data as any).momentumQualityScore >= 80 ? "bg-emerald-400" :
                            (data as any).momentumQualityScore >= 60 ? "bg-success" :
                            (data as any).momentumQualityScore >= 40 ? "bg-warning" : "bg-destructive/60",
                          )}
                          style={{ width: `${(data as any).momentumQualityScore ?? 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Row: Stacking Safe */}
                  {(data.signal === "BUY" || data.signal === "SELL") && typeof (data as any).stackingSafe === "boolean" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Stacking</span>
                      <span className={cn(
                        "font-bold tracking-widest text-[9px]",
                        (data as any).stackingSafe ? "text-success" : "text-muted-foreground/60",
                      )}>
                        {(data as any).stackingSafe ? "✓ SAFE" : "✗ BLOCKED"}
                      </span>
                    </div>
                  )}

                  {/* Row: Structure Labels HH/HL/LH/LL */}
                  {(data as any).structureLabels && ((data as any).structureLabels as string[]).length > 0 && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Swings</span>
                      <span className="font-mono text-[9px] tracking-widest text-muted-foreground/70 flex gap-1">
                        {((data as any).structureLabels as string[]).slice(0, 4).map((lbl: string, i: number) => (
                          <span key={i} className={cn(
                            "px-1 rounded",
                            (lbl === "HH" || lbl === "HL") ? "text-success/80" : "text-destructive/80",
                          )}>{lbl}</span>
                        ))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Multi-Timeframe Confirmation panel */}
              {(data.higherTrend || data.mtfStatus) && (
                <div className="mt-3 w-full max-w-[260px] mx-auto rounded-md border border-border/40 bg-card/40 px-3 py-2 text-[10px] tracking-wide space-y-1">
                  {data.higherTrend && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Higher TF (15m)</span>
                      <span className={cn(
                        "font-bold",
                        data.higherTrend === "BULLISH" && "text-success",
                        data.higherTrend === "BEARISH" && "text-destructive",
                        data.higherTrend === "NEUTRAL" && "text-muted-foreground",
                      )}>{data.higherTrend}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Entry TF ({data.timeframe})</span>
                    <span className={cn(
                      "font-bold",
                      data.signal === "BUY"   && "text-success",
                      data.signal === "SELL"  && "text-destructive",
                      data.signal === "SETUP" && "text-primary",
                      data.signal === "HOLD"  && "text-muted-foreground",
                    )}>{data.signal}</span>
                  </div>
                  {data.mtfStatus && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">MTF Status</span>
                      <span className={cn(
                        "font-bold tracking-widest inline-flex items-center gap-1",
                        (data.mtfStatus === "ALIGNED" || data.mtfStatus === "SUPPORTIVE") && "text-success",
                        (data.mtfStatus === "BLOCKED" || data.mtfStatus === "CONTRA")     && "text-destructive",
                        (data.mtfStatus === "WAITING" || data.mtfStatus === "NEUTRAL")    && "text-muted-foreground",
                        data.mtfStatus === "SETUP_FORMING"                                && "text-primary",
                      )}>
                        {data.mtfStatus === "SETUP_FORMING" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                        )}
                        {data.mtfStatus === "SETUP_FORMING" ? "SETUP FORMING" : data.mtfStatus}
                      </span>
                    </div>
                  )}
                  {data.momentumBias && data.momentumBias !== "NEUTRAL" && (
                    <div className="flex items-center justify-between pt-1 border-t border-border/30">
                      <span className="text-muted-foreground">Trend Memory</span>
                      <span className={cn(
                        "font-bold tracking-widest inline-flex items-center gap-1",
                        data.momentumBias === "BULLISH" && "text-success",
                        data.momentumBias === "BEARISH" && "text-destructive",
                      )}>
                        {data.momentumBias === "BULLISH" ? "↗" : "↘"} {data.momentumBias}
                        {typeof data.momentumScore === "number" && (
                          <span className="text-muted-foreground/70 font-normal">
                            ({data.momentumScore >= 0 ? "+" : ""}{data.momentumScore.toFixed(2)}R)
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Status + Type badges (BUY/SELL only) */}
              {(data.signal === "BUY" || data.signal === "SELL") && (data.signalStatus || data.signalType || data.entryQuality) && (
                <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
                  {data.entryQuality && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border inline-flex items-center gap-1",
                      data.entryQuality === "CONFIRMED"
                        ? "text-success border-success/40 bg-success/10"
                        : "text-primary border-primary/40 bg-primary/10"
                    )}>
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        data.entryQuality === "CONFIRMED" ? "bg-success" : "bg-primary animate-pulse"
                      )} />
                      {data.entryQuality}
                    </span>
                  )}
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
                  {(data.signalCategory || data.signalType) && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border",
                      (data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM")
                        ? "text-amber-300 border-amber-400/40 bg-amber-400/10"
                        : (data.signalCategory === "PULLBACK" || data.signalType === "PULLBACK")
                          ? "text-success border-success/40 bg-success/10"
                          : (data.signalCategory === "REVERSAL" || data.signalType === "REVERSAL")
                            ? "text-warning border-warning/30 bg-warning/10"
                            : "text-primary border-primary/30 bg-primary/10"
                    )}>
                      {(data.signalCategory === "MOMENTUM" || data.signalType === "MOMENTUM") ? "⚡ STRONG MOMENTUM"
                        : (data.signalCategory === "PULLBACK" || data.signalType === "PULLBACK") ? "↩ PULLBACK"
                        : (data.signalCategory === "REVERSAL" || data.signalType === "REVERSAL") ? "↗ REVERSAL TRADE"
                        : "TREND TRADE"}
                    </span>
                  )}
                  {data.entryMode && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border",
                      data.entryMode === "AUTO"
                        ? "text-amber-300 border-amber-400/40 bg-amber-400/10"
                        : data.entryMode === "CONFIRMED"
                          ? "text-success border-success/40 bg-success/10"
                          : "text-muted-foreground border-border/30 bg-card/30",
                    )}>
                      {data.entryMode === "AUTO" ? "AUTO ENTRY"
                        : data.entryMode === "CONFIRMED" ? "✓ CONFIRMED"
                        : "WAITING"}
                    </span>
                  )}
                  {data.entryType && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border",
                      data.entryType === "FIRST_ENTRY"  && "text-success border-success/30 bg-success/10",
                      data.entryType === "ADD_ON"        && "text-primary border-primary/30 bg-primary/10",
                      data.entryType === "REVERSAL"      && "text-amber-300 border-amber-400/30 bg-amber-400/10",
                    )}>
                      {data.entryType === "FIRST_ENTRY" ? "FIRST ENTRY"
                        : data.entryType === "ADD_ON"   ? "ADD-ON"
                        : "REVERSAL"}
                    </span>
                  )}
                  {data.executionStatus && data.executionStatus !== "EXECUTED" && (
                    <span className={cn(
                      "px-2.5 py-1 rounded-full text-[10px] font-bold tracking-widest border",
                      data.executionStatus === "LIMITED"
                        ? "text-amber-300 border-amber-400/30 bg-amber-400/10"
                        : "text-muted-foreground border-border/40 bg-card/40",
                    )}>
                      {data.executionStatus === "LIMITED" ? "NOT EXECUTED" : "SKIPPED"}
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

              {/* Engine Debug Panel — collapsible, shows full breakdown */}
              {((data as any).debugInfo || (data as any).weightedConfidenceBreakdown || (data as any).structureDebug || (data as any).momentumDebug) && (
                <details className="mt-3 w-full max-w-[300px] mx-auto">
                  <summary className="cursor-pointer select-none text-[9px] uppercase tracking-widest text-muted-foreground/40 text-center py-1 hover:text-muted-foreground/60 transition-colors">
                    Engine Debug Panel ▸
                  </summary>
                  <div className="mt-1.5 rounded-md border border-border/30 bg-card/30 px-3 py-2 text-[9px] text-muted-foreground/60 space-y-2 font-mono">

                    {/* Weighted Confidence Breakdown */}
                    {(data as any).weightedConfidenceBreakdown && (
                      <div className="space-y-1">
                        <div className="text-[8px] uppercase tracking-widest text-muted-foreground/40 pb-0.5 border-b border-border/20">Weighted Confidence</div>
                        {[
                          { label: "Structure",  val: (data as any).weightedConfidenceBreakdown.structure,     max: 25 },
                          { label: "EMA",        val: (data as any).weightedConfidenceBreakdown.ema,           max: 15 },
                          { label: "Momentum",   val: (data as any).weightedConfidenceBreakdown.momentum,      max: 20 },
                          { label: "MTF",        val: (data as any).weightedConfidenceBreakdown.mtf,           max: 15 },
                          { label: "RSI",        val: (data as any).weightedConfidenceBreakdown.rsi,           max: 5  },
                          { label: "Chop",       val: (data as any).weightedConfidenceBreakdown.chopFilter,    max: 10 },
                          { label: "Vol/Vel",    val: (data as any).weightedConfidenceBreakdown.velocityVolume, max: 10 },
                        ].map(({ label, val, max }) => (
                          <div key={label} className="flex items-center gap-2">
                            <span className="text-muted-foreground/40 w-16 shrink-0">{label}</span>
                            <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                              <div
                                className={cn("h-full rounded-full", val / max >= 0.7 ? "bg-success/60" : val / max >= 0.4 ? "bg-warning/50" : "bg-destructive/40")}
                                style={{ width: `${Math.round((val / max) * 100)}%` }}
                              />
                            </div>
                            <span className={cn("w-8 text-right", val / max >= 0.7 ? "text-success/70" : val / max >= 0.4 ? "text-warning/60" : "text-destructive/50")}>
                              {val}/{max}
                            </span>
                          </div>
                        ))}
                        <div className={cn(
                          "flex justify-between pt-0.5 border-t border-border/20 font-bold",
                          (data as any).weightedConfidenceBreakdown.total >= 80 ? "text-success/80" :
                          (data as any).weightedConfidenceBreakdown.total >= 60 ? "text-warning/70" : "text-destructive/60",
                        )}>
                          <span>TOTAL</span>
                          <span>{(data as any).weightedConfidenceBreakdown.total}/100</span>
                        </div>
                      </div>
                    )}

                    {/* Structure Engine */}
                    {(data as any).structureDebug && (
                      <div className="space-y-0.5">
                        <div className="text-[8px] uppercase tracking-widest text-muted-foreground/40 pb-0.5 border-b border-border/20">Structure Engine</div>
                        <div className="text-muted-foreground/50 break-all">{(data as any).structureDebug}</div>
                      </div>
                    )}

                    {/* Momentum Engine */}
                    {(data as any).momentumDebug && (
                      <div className="space-y-0.5">
                        <div className="text-[8px] uppercase tracking-widest text-muted-foreground/40 pb-0.5 border-b border-border/20">Momentum Engine</div>
                        <div className="text-muted-foreground/50 break-all">{(data as any).momentumDebug}</div>
                      </div>
                    )}

                    {/* Advanced Engine (RSI div, MACD decay) */}
                    {(data as any).debugInfo && (
                      <div className="space-y-0.5">
                        <div className="text-[8px] uppercase tracking-widest text-muted-foreground/40 pb-0.5 border-b border-border/20">Reversal Engine</div>
                        <div><span className="text-muted-foreground/40">RSI Div:</span> {(data as any).debugInfo.rsiDivergence}</div>
                        <div><span className="text-muted-foreground/40">MACD:</span> {(data as any).debugInfo.macdDecay}</div>
                        <div><span className="text-muted-foreground/40">Displace:</span> {(data as any).debugInfo.oppositeDisplacement}</div>
                        <div className={cn(
                          "font-bold",
                          (data as any).debugInfo.confidenceAdj < 0 ? "text-destructive/70" :
                          (data as any).debugInfo.confidenceAdj > 0 ? "text-success/70" : "text-muted-foreground/40"
                        )}>
                          Conf Adj: {(data as any).debugInfo.confidenceAdj > 0 ? "+" : ""}{(data as any).debugInfo.confidenceAdj}
                        </div>
                        {(data as any).debugInfo.reversalFactors?.length > 0 && (
                          <div className="text-warning/60">Risk: {((data as any).debugInfo.reversalFactors as string[]).join(" · ")}</div>
                        )}
                      </div>
                    )}

                    {/* Exhaustion reasons */}
                    {(data as any).momentumExhaustionReasons?.length > 0 && (
                      <div className="space-y-0.5">
                        <div className="text-[8px] uppercase tracking-widest text-warning/40 pb-0.5 border-b border-border/20">Exhaustion Reasons</div>
                        {((data as any).momentumExhaustionReasons as string[]).map((r: string, i: number) => (
                          <div key={i} className="text-warning/60">• {r}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
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

            {/* Trade Parameters — Entry, SL, TP1 (partial), TP2 (final).
                Always shown so the user can see what the trade WOULD look like
                even on WATCHLIST / BLOCKED setups. The permission badge above
                the card already communicates whether the setup is actionable
                or just informational, so we never hide the levels themselves. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <Target className="h-4 w-4 text-blue-400 mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">Entry</span>
                <span className="font-numbers font-bold text-foreground text-sm">
                  {data.entry ? `$${data.entry.toFixed(2)}` : "—"}
                </span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <ShieldAlert className="h-4 w-4 text-destructive mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">Stop Loss</span>
                <span className="font-numbers font-bold text-destructive text-sm">
                  {data.stopLoss ? `$${data.stopLoss.toFixed(2)}` : "—"}
                </span>
                <span className="text-[9px] uppercase text-muted-foreground/60 mt-1">1.0× ATR</span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-white/[0.02] border border-white/5">
                <Coins className="h-4 w-4 text-success/80 mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">TP1 · Partial</span>
                <span className="font-numbers font-bold text-success/85 text-sm">
                  {data.tp1 ? `$${data.tp1.toFixed(2)}` : "—"}
                </span>
                <span className="text-[9px] uppercase text-muted-foreground/60 mt-1">1.2 R</span>
              </div>
              <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-success/5 border border-success/20">
                <Coins className="h-4 w-4 text-success mb-2" />
                <span className="text-[10px] uppercase text-muted-foreground mb-1">TP2 · Final</span>
                <span className="font-numbers font-bold text-success text-sm">
                  {data.tp2 ? `$${data.tp2.toFixed(2)}` : (data.takeProfit ? `$${data.takeProfit.toFixed(2)}` : "—")}
                </span>
                <span className="text-[9px] uppercase text-muted-foreground/60 mt-1">2.2 R</span>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-3 border-t border-white/5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Trend:</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs font-bold gap-1 py-0.5 tracking-wide",
                    getSmartTrendColors(data.trend, data.trendStrength),
                  )}
                >
                  {getTrendIcon(data.trend)} {getSmartTrendLabel(data.trend, data.trendStrength)}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
                <span className="font-numbers">{formatTimeIST(data.timestamp)}</span>
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
