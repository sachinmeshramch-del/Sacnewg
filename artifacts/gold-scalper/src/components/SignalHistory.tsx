import { useMemo, useState } from "react";
import { useSignalHistory } from "@/hooks/use-trading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { History, Clock, Flame, Zap, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

type SignalType = "STRONG" | "NORMAL" | "WEAK" | "IGNORE";
type FilterMode = "ALL" | "STRONG" | "NORMAL" | "WEAK";

interface SignalRow {
  id: number;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  timeframe: string;
  timestamp: string;
  outcome: "WIN" | "LOSS" | "PENDING" | null;
  signalType: SignalType;
}

function classify(confidence: number): SignalType {
  if (confidence >= 65) return "STRONG";
  if (confidence >= 50) return "NORMAL";
  if (confidence >= 40) return "WEAK";
  return "IGNORE";
}

function getConfidenceColor(c: number) {
  if (c > 70) return "text-success";
  if (c >= 50) return "text-warning";
  return "text-destructive";
}

function getConfidenceBarColor(c: number) {
  if (c > 70) return "bg-success";
  if (c >= 50) return "bg-warning";
  return "bg-destructive";
}

function TypeBadge({ type }: { type: SignalType }) {
  if (type === "STRONG") {
    return (
      <Badge
        variant="outline"
        className="border-success/40 bg-success/10 text-success py-0 text-[10px] gap-1 font-bold"
      >
        <Flame className="h-3 w-3" />
        STRONG
      </Badge>
    );
  }
  if (type === "NORMAL") {
    return (
      <Badge
        variant="outline"
        className="border-warning/40 bg-warning/10 text-warning py-0 text-[10px] gap-1 font-bold"
      >
        <Zap className="h-3 w-3" />
        NORMAL
      </Badge>
    );
  }
  if (type === "WEAK") {
    return (
      <Badge
        variant="outline"
        className="border-destructive/40 bg-destructive/10 text-destructive py-0 text-[10px] gap-1 font-bold"
      >
        <AlertTriangle className="h-3 w-3" />
        WEAK
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-white/10 bg-white/5 text-muted-foreground py-0 text-[10px]"
    >
      IGNORE
    </Badge>
  );
}

function ConfidenceCell({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center justify-end gap-2 min-w-[90px]">
      <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden max-w-[50px]">
        <div
          className={cn("h-full rounded-full transition-all", getConfidenceBarColor(value))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn("font-numbers text-xs font-bold tabular-nums", getConfidenceColor(value))}>
        {value.toFixed(0)}%
      </span>
    </div>
  );
}

function SignalTable({
  rows,
  emptyMessage,
  showType = true,
}: {
  rows: SignalRow[];
  emptyMessage: string;
  showType?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center">
        <Clock className="h-7 w-7 mb-2 opacity-50" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <div className="overflow-auto max-h-[400px]">
      <Table>
        <TableHeader className="bg-secondary/50 sticky top-0 backdrop-blur-md z-10 border-b border-white/5">
          <TableRow className="hover:bg-transparent border-white/5">
            <TableHead className="text-xs">Time</TableHead>
            <TableHead className="text-xs">TF</TableHead>
            <TableHead className="text-xs">Signal</TableHead>
            {showType && <TableHead className="text-xs">Type</TableHead>}
            <TableHead className="text-xs text-right">Confidence</TableHead>
            <TableHead className="text-xs text-right">Entry</TableHead>
            <TableHead className="text-xs text-right">SL</TableHead>
            <TableHead className="text-xs text-right">TP</TableHead>
            <TableHead className="text-xs text-center">Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(trade => (
            <TableRow key={trade.id} className="border-white/5 hover:bg-white/[0.02]">
              <TableCell className="text-xs font-numbers text-muted-foreground whitespace-nowrap">
                {format(new Date(trade.timestamp), "MMM dd, HH:mm")}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{trade.timeframe}</TableCell>
              <TableCell>
                <span
                  className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider",
                    trade.signal === "BUY"
                      ? "bg-success/20 text-success"
                      : trade.signal === "SELL"
                      ? "bg-destructive/20 text-destructive"
                      : "bg-warning/20 text-warning",
                  )}
                >
                  {trade.signal}
                </span>
              </TableCell>
              {showType && (
                <TableCell>
                  <TypeBadge type={trade.signalType} />
                </TableCell>
              )}
              <TableCell className="text-right">
                <ConfidenceCell value={trade.confidence} />
              </TableCell>
              <TableCell className="text-right font-numbers text-xs">
                ${trade.entry.toFixed(2)}
              </TableCell>
              <TableCell className="text-right font-numbers text-xs text-destructive/80">
                ${trade.stopLoss.toFixed(2)}
              </TableCell>
              <TableCell className="text-right font-numbers text-xs text-success/80">
                ${trade.takeProfit.toFixed(2)}
              </TableCell>
              <TableCell className="text-center">
                {trade.outcome === "WIN" ? (
                  <Badge
                    variant="outline"
                    className="bg-success/10 text-success border-success/20 py-0 text-[10px]"
                  >
                    WIN
                  </Badge>
                ) : trade.outcome === "LOSS" ? (
                  <Badge
                    variant="outline"
                    className="bg-destructive/10 text-destructive border-destructive/20 py-0 text-[10px]"
                  >
                    LOSS
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-white/5 text-muted-foreground border-white/10 py-0 text-[10px]"
                  >
                    PENDING
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SignalHistory() {
  const { data, isLoading } = useSignalHistory();
  const [filter, setFilter] = useState<FilterMode>("ALL");

  const allRows = useMemo<SignalRow[]>(() => {
    if (!data?.signals) return [];
    return data.signals.map(s => ({
      id: s.id,
      signal: s.signal,
      confidence: s.confidence,
      entry: s.entry,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      timeframe: s.timeframe,
      timestamp: s.timestamp,
      outcome: (s.outcome ?? "PENDING") as SignalRow["outcome"],
      // Backend now sends signalType; fall back to client-side classification
      // for older history entries that don't have it persisted.
      signalType: ((s as { signalType?: SignalType }).signalType ?? classify(s.confidence)) as SignalType,
    }));
  }, [data]);

  // Auto-priority: latest STRONG directional signal (BUY/SELL only).
  const latestStrong = useMemo(
    () => allRows.find(r => r.signalType === "STRONG" && (r.signal === "BUY" || r.signal === "SELL")),
    [allRows],
  );

  // Tradable: STRONG + NORMAL, sorted by confidence desc, capped at 20.
  const tradableRows = useMemo(
    () =>
      allRows
        .filter(r => r.signalType === "STRONG" || r.signalType === "NORMAL")
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 20),
    [allRows],
  );

  const weakRows = useMemo(
    () => allRows.filter(r => r.signalType === "WEAK"),
    [allRows],
  );

  const filteredAllRows = useMemo(() => {
    if (filter === "ALL") return allRows;
    return allRows.filter(r => r.signalType === filter);
  }, [allRows, filter]);

  const filterCounts = useMemo(
    () => ({
      ALL: allRows.length,
      STRONG: allRows.filter(r => r.signalType === "STRONG").length,
      NORMAL: allRows.filter(r => r.signalType === "NORMAL").length,
      WEAK: weakRows.length,
    }),
    [allRows, weakRows],
  );

  if (isLoading) {
    return (
      <Card className="border-white/10 bg-card/80 backdrop-blur-xl">
        <CardContent className="p-6 space-y-4 animate-pulse">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-10 bg-white/5 rounded-md" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Auto Priority Display — latest STRONG signal */}
      {latestStrong && (
        <Card
          className={cn(
            "border-2 backdrop-blur-xl overflow-hidden relative",
            latestStrong.signal === "BUY"
              ? "border-success/50 bg-success/[0.04] shadow-[0_0_40px_rgba(22,163,74,0.18)]"
              : "border-destructive/50 bg-destructive/[0.04] shadow-[0_0_40px_rgba(225,29,72,0.18)]",
          )}
          data-testid="card-priority-signal"
        >
          <div
            className={cn(
              "absolute top-0 right-0 w-72 h-72 blur-[120px] pointer-events-none rounded-full",
              latestStrong.signal === "BUY" ? "bg-success/15" : "bg-destructive/15",
            )}
          />
          <CardContent className="p-5 relative">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <Flame
                  className={cn(
                    "h-7 w-7",
                    latestStrong.signal === "BUY" ? "text-success" : "text-destructive",
                  )}
                />
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Priority Signal
                  </span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={cn(
                        "text-2xl font-black tracking-widest",
                        latestStrong.signal === "BUY" ? "text-success" : "text-destructive",
                      )}
                    >
                      STRONG {latestStrong.signal}
                    </span>
                    {latestStrong.signal === "BUY" ? (
                      <TrendingUp className="h-5 w-5 text-success" />
                    ) : (
                      <TrendingDown className="h-5 w-5 text-destructive" />
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Confidence
                  </span>
                  <span
                    className={cn(
                      "text-2xl font-black font-numbers tabular-nums",
                      getConfidenceColor(latestStrong.confidence),
                    )}
                  >
                    {latestStrong.confidence.toFixed(0)}%
                  </span>
                </div>
                <div className="h-10 w-px bg-white/10 mx-2" />
                <div className="grid grid-cols-3 gap-3 text-right">
                  <div>
                    <div className="text-[9px] uppercase text-muted-foreground tracking-wider">
                      Entry
                    </div>
                    <div className="font-numbers text-sm font-bold">
                      ${latestStrong.entry.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-muted-foreground tracking-wider">
                      SL
                    </div>
                    <div className="font-numbers text-sm font-bold text-destructive/90">
                      ${latestStrong.stopLoss.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase text-muted-foreground tracking-wider">
                      TP
                    </div>
                    <div className="font-numbers text-sm font-bold text-success/90">
                      ${latestStrong.takeProfit.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground tracking-wide">
              <span>{latestStrong.timeframe.toUpperCase()}</span>
              <span>•</span>
              <span>{format(new Date(latestStrong.timestamp), "MMM dd, HH:mm")}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tradable Signals Table — STRONG + NORMAL, sorted by confidence desc */}
      <Card className="border-white/10 bg-card/80 backdrop-blur-xl">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-success" />
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tradable Signals
            </CardTitle>
            <Badge
              variant="outline"
              className="border-white/10 bg-white/5 text-muted-foreground py-0 text-[10px] ml-1"
            >
              {tradableRows.length}
            </Badge>
            <span className="text-[10px] text-muted-foreground/70 ml-auto">
              STRONG + NORMAL · sorted by confidence
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0" data-testid="table-tradable">
          <SignalTable
            rows={tradableRows}
            emptyMessage="No tradable signals yet"
          />
        </CardContent>
      </Card>

      {/* Weak Signals Table */}
      <Card className="border-white/10 bg-card/80 backdrop-blur-xl">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive/80" />
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Weak Signals
            </CardTitle>
            <Badge
              variant="outline"
              className="border-white/10 bg-white/5 text-muted-foreground py-0 text-[10px] ml-1"
            >
              {weakRows.length}
            </Badge>
            <span className="text-[10px] text-muted-foreground/70 ml-auto">
              Confidence 40–49% · low priority
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0" data-testid="table-weak">
          <SignalTable rows={weakRows} emptyMessage="No weak signals" />
        </CardContent>
      </Card>

      {/* All Signals Table with filter buttons */}
      <Card className="border-white/10 bg-card/80 backdrop-blur-xl flex flex-col">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium text-muted-foreground">
              All Signals
            </CardTitle>
            <div className="ml-auto flex items-center gap-1 bg-secondary p-1 rounded-lg border border-white/5">
              {(["ALL", "STRONG", "NORMAL", "WEAK"] as FilterMode[]).map(f => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "ghost"}
                  size="sm"
                  className={cn(
                    "h-7 px-3 text-[11px] font-bold tracking-wider gap-1",
                    filter !== f && "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setFilter(f)}
                  data-testid={`button-filter-${f.toLowerCase()}`}
                >
                  {f === "STRONG" && <Flame className="h-3 w-3" />}
                  {f === "NORMAL" && <Zap className="h-3 w-3" />}
                  {f === "WEAK" && <AlertTriangle className="h-3 w-3" />}
                  {f}
                  <span className="opacity-60 font-normal">({filterCounts[f]})</span>
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 relative" data-testid="table-all">
          {!data || allRows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center">
              <Clock className="h-8 w-8 mb-3 opacity-50" />
              <p>No trading history available</p>
            </div>
          ) : (
            <SignalTable
              rows={filteredAllRows}
              emptyMessage={`No ${filter.toLowerCase()} signals`}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
