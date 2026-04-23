import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Activity, Radio, Cpu } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Header() {
  const [time, setTime] = useState(new Date());
  
  const { data: health, isSuccess } = useHealthCheck({
    query: { refetchInterval: 30000 }
  });

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8 mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 border border-accent/20">
            <Activity className="h-6 w-6 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-foreground leading-none">
              GOLD SCALPER <span className="text-accent">AI</span>
            </h1>
            <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 mt-0.5">
              <Cpu className="h-3 w-3" />
              XAUUSD Trading Terminal
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-sm font-numbers font-medium text-foreground">
              {format(time, "HH:mm:ss")} UTC
            </span>
            <span className="text-xs text-muted-foreground">
              {format(time, "MMM dd, yyyy")}
            </span>
          </div>

          <div className="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-3 py-1.5 shadow-inner">
            <div className="relative flex h-2.5 w-2.5">
              {isSuccess ? (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-success"></span>
                </>
              ) : (
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-destructive"></span>
              )}
            </div>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {isSuccess ? "System Online" : "Connecting..."}
            </span>
            <Radio className="h-3.5 w-3.5 text-muted-foreground ml-1" />
          </div>
        </div>
      </div>
    </header>
  );
}
