import { useState } from "react";
import { Header } from "@/components/Header";
import { LivePriceBar } from "@/components/LivePriceBar";
import { SignalPanel } from "@/components/SignalPanel";
import { IndicatorsPanel } from "@/components/IndicatorsPanel";
import { TradingViewWidget } from "@/components/TradingViewWidget";
import { SignalHistory } from "@/components/SignalHistory";
import { useCurrentSignal } from "@/hooks/use-trading";

export function Dashboard() {
  const [timeframe, setTimeframe] = useState<"1m" | "5m">("5m");
  const { data: signalData, isLoading: signalLoading } = useCurrentSignal(timeframe);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col pb-12">
      <Header />

      <main className="container max-w-[1600px] px-4 sm:px-6 lg:px-8 mx-auto mt-6 flex flex-col gap-6">

        {/* TradingView Chart — full width at top */}
        <section className="w-full h-[520px] rounded-xl overflow-hidden border border-white/10 shadow-2xl shadow-black/50">
          <TradingViewWidget timeframe={timeframe} />
        </section>

        {/* Live Price — below chart */}
        <section className="w-full">
          <LivePriceBar />
        </section>

        {/* Signal + Indicators row */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

          {/* AI Signal Panel — 4 cols */}
          <div className="lg:col-span-4">
            <SignalPanel
              timeframe={timeframe}
              onTimeframeChange={setTimeframe}
            />
          </div>

          {/* Indicators Panel — 8 cols */}
          <div className="lg:col-span-8">
            <IndicatorsPanel
              indicators={signalData?.indicators}
              marketMode={signalData?.marketMode}
              isLoading={signalLoading}
            />
          </div>
        </section>

        {/* Signal History — full width */}
        <section className="w-full">
          <SignalHistory />
        </section>

      </main>
    </div>
  );
}
