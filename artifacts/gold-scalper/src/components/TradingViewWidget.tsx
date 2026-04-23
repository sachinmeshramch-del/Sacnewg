import { memo } from 'react';
import { Card } from '@/components/ui/card';

interface TradingViewWidgetProps {
  timeframe: "1m" | "5m";
}

export const TradingViewWidget = memo(function TradingViewWidget({ timeframe }: TradingViewWidgetProps) {
  const intervalMap: Record<string, string> = {
    "1m": "1",
    "5m": "5",
  };

  const params = new URLSearchParams({
    symbol: "OANDA:XAUUSD",
    interval: intervalMap[timeframe],
    theme: "dark",
    style: "1",
    locale: "en",
    toolbar_bg: "#0A0A0F",
    enable_publishing: "false",
    allow_symbol_change: "false",
    save_image: "false",
    hide_volume: "false",
    backgroundColor: "rgba(10,10,15,1)",
    gridColor: "rgba(255,255,255,0.05)",
    withdateranges: "true",
    hide_side_toolbar: "false",
    details: "false",
    calendar: "false",
    hotlist: "false",
  });

  const src = `https://s.tradingview.com/widgetembed/?${params.toString()}`;

  return (
    <Card className="border-white/10 bg-[#0A0A0F] overflow-hidden w-full h-full min-h-[500px] relative">
      <iframe
        key={timeframe}
        src={src}
        title="XAUUSD Chart"
        style={{ width: "100%", height: "100%", minHeight: 500, border: "none", display: "block" }}
        allow="clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </Card>
  );
});
