import { useMemo, useState } from "react";
import { useSignalHistory } from "@/hooks/use-trading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import { Clock, Flame, Zap, AlertTriangle, TrendingUp, TrendingDown, Minus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getGetHistoryQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

type Strength = "STRONG" | "MODERATE" | "WEAK" | "IGNORE";

interface SignalRow {
  id: number;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  trend: string;
  timeframe: string;
  timestamp: string;
  strength: Strength;
}

const MAX_PER_TABLE = 20;

function classify(confidence: number): Strength {
  if (confidence >= 65) return "STRONG";
  if (confidence >= 50) return "MODERATE";
  // Everything from 0–49 is now WEAK.
  return "WEAK";
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

function TrendCell({ trend }: { trend: string }) {
  const t = trend?.toUpperCase();
  if (t === "BULLISH") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
        <TrendingUp className="h-3 w-3" />
        BULLISH
      </span>
    );
  }
  if (t === "BEARISH") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
        <TrendingDown className="h-3 w-3" />
        BEARISH
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Minus className="h-3 w-3" />
      NEUTRAL
    </span>
  );
}

function SignalTable({
  rows,
  emptyMessage,
  faded = false,
}: {
  rows: SignalRow[];
  emptyMessage: string;
  faded?: boolean;
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
    <div className={cn("overflow-auto max-h-[400px]", faded && "opacity-70")}>
      <Table>
        <TableHeader className="bg-secondary/50 sticky top-0 backdrop-blur-md z-10 border-b border-white/5">
          <TableRow className="hover:bg-transparent border-white/5">
            <TableHead className="text-xs">Time</TableHead>
            <TableHead className="text-xs">TF</TableHead>
            <TableHead className="text-xs">Signal</TableHead>
            <TableHead className="text-xs text-right">Entry</TableHead>
            <TableHead className="text-xs text-right">SL</TableHead>
            <TableHead className="text-xs text-right">TP</TableHead>
            <TableHead className="text-xs text-right">Confidence</TableHead>
            <TableHead className="text-xs">Trend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.id} className="border-white/5 hover:bg-white/[0.02]">
              <TableCell className="text-xs font-numbers text-muted-foreground whitespace-nowrap">
                {format(new Date(row.timestamp), "MMM dd, HH:mm")}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.timeframe}</TableCell>
              <TableCell>
                <span
                  className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider",
                    row.signal === "BUY"
                      ? "bg-success/20 text-success"
                      : row.signal === "SELL"
                      ? "bg-destructive/20 text-destructive"
                      : "bg-warning/20 text-warning",
                  )}
                >
                  {row.signal}
                </span>
              </TableCell>
              <TableCell className="text-right font-numbers text-xs">
                ${row.entry.toFixed(2)}
              </TableCell>
              <TableCell className="text-right font-numbers text-xs text-destructive/80">
                ${row.stopLoss.toFixed(2)}
              </TableCell>
              <TableCell className="text-right font-numbers text-xs text-success/80">
                ${row.takeProfit.toFixed(2)}
              </TableCell>
              <TableCell className="text-right">
                <ConfidenceCell value={row.confidence} />
              </TableCell>
              <TableCell>
                <TrendCell trend={row.trend} />
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
  const [strongOnly, setStrongOnly] = useState(false);
  const [clearingTier, setClearingTier] = useState<Exclude<Strength, "IGNORE"> | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  function ClearTierButton({
    tier,
    count,
    label,
  }: {
    tier: Exclude<Strength, "IGNORE">;
    count: number;
    label: string;
  }) {
    const isClearing = clearingTier === tier;
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-muted-foreground/70 hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
            disabled={isClearing || count === 0}
            data-testid={`button-clear-${tier.toLowerCase()}`}
            title={`Clear ${label} signals`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wider hidden sm:inline">
              {isClearing ? "Clearing" : "Clear"}
            </span>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent data-testid={`dialog-clear-${tier.toLowerCase()}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {label.toLowerCase()} signals?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all {count} signal{count === 1 ? "" : "s"}{" "}
              from the {label} table. Other tables won't be affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-clear-${tier.toLowerCase()}`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleClear(tier)}
              className="bg-sky-600 text-white hover:bg-sky-500"
              data-testid={`button-confirm-clear-${tier.toLowerCase()}`}
            >
              Yes, clear {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  async function handleClear(tier: Exclude<Strength, "IGNORE">) {
    setClearingTier(tier);
    try {
      const res = await fetch(`/api/history?strength=${tier}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { cleared?: number };
      await queryClient.invalidateQueries({ queryKey: getGetHistoryQueryKey() });
      toast({
        title: `${tier} signals cleared`,
        description: `Removed ${json.cleared ?? 0} signals from the ${tier.toLowerCase()} table.`,
      });
    } catch (err) {
      toast({
        title: "Failed to clear history",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setClearingTier(null);
    }
  }

  const allRows = useMemo<SignalRow[]>(() => {
    if (!data?.signals) return [];
    return data.signals
      .map(s => ({
        id: s.id,
        signal: s.signal,
        confidence: s.confidence,
        entry: s.entry,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        trend: s.trend,
        timeframe: s.timeframe,
        timestamp: s.timestamp,
        strength: ((s as { signalType?: Strength }).signalType ?? classify(s.confidence)) as Strength,
      }))
      .filter(r => r.strength !== "IGNORE");
  }, [data]);

  // Dedup by id first, then sort by confidence DESC (highest first), with
  // newest timestamp as the tiebreaker. Cap at MAX_PER_TABLE.
  const bucket = (kind: Exclude<Strength, "IGNORE">) =>
    Array.from(
      new Map(
        allRows.filter(r => r.strength === kind).map(r => [r.id, r]),
      ).values(),
    )
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      })
      .slice(0, MAX_PER_TABLE);

  const strongRows = useMemo(() => bucket("STRONG"), [allRows]);
  const moderateRows = useMemo(() => bucket("MODERATE"), [allRows]);
  const weakRows = useMemo(() => bucket("WEAK"), [allRows]);

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
      {/* Toolbar: Strong-only toggle (per-table clear buttons live in each card) */}
      <div className="flex items-center justify-end gap-3 px-1">
        <Label
          htmlFor="strong-only"
          className="text-xs uppercase tracking-wider text-muted-foreground cursor-pointer"
        >
          Show Only Strong Signals
        </Label>
        <Switch
          id="strong-only"
          checked={strongOnly}
          onCheckedChange={setStrongOnly}
          data-testid="switch-strong-only"
        />
      </div>

      {/* STRONG SIGNALS — High Priority */}
      <Card
        className="border-success/30 bg-card/80 backdrop-blur-xl shadow-[0_0_30px_rgba(22,163,74,0.06)]"
        data-testid="table-strong"
      >
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-success" />
            <CardTitle className="text-sm font-bold text-success uppercase tracking-wider">
              Strong Signals
            </CardTitle>
            <Badge
              variant="outline"
              className="border-success/40 bg-success/10 text-success py-0 text-[10px] ml-1"
            >
              {strongRows.length}
            </Badge>
            <span className="text-[10px] text-muted-foreground/70 ml-auto">
              Confidence ≥ 65 · High Priority
            </span>
            <ClearTierButton tier="STRONG" count={strongRows.length} label="Strong" />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <SignalTable rows={strongRows} emptyMessage="No strong signals yet" />
        </CardContent>
      </Card>

      {/* MODERATE SIGNALS */}
      {!strongOnly && (
        <Card className="border-warning/20 bg-card/80 backdrop-blur-xl" data-testid="table-moderate">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-warning" />
              <CardTitle className="text-sm font-bold text-warning uppercase tracking-wider">
                Moderate Signals
              </CardTitle>
              <Badge
                variant="outline"
                className="border-warning/40 bg-warning/10 text-warning py-0 text-[10px] ml-1"
              >
                {moderateRows.length}
              </Badge>
              <span className="text-[10px] text-muted-foreground/70 ml-auto">
                Confidence 50–64 · Medium Priority
              </span>
              <ClearTierButton tier="MODERATE" count={moderateRows.length} label="Moderate" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <SignalTable rows={moderateRows} emptyMessage="No moderate signals" />
          </CardContent>
        </Card>
      )}

      {/* WEAK SIGNALS */}
      {!strongOnly && (
        <Card className="border-white/5 bg-card/40 backdrop-blur-xl" data-testid="table-weak">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive/70" />
              <CardTitle className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
                Weak Signals
              </CardTitle>
              <Badge
                variant="outline"
                className="border-white/10 bg-white/5 text-muted-foreground py-0 text-[10px] ml-1"
              >
                {weakRows.length}
              </Badge>
              <span className="text-[10px] text-muted-foreground/70 ml-auto">
                Confidence 0–49 · Low Priority
              </span>
              <ClearTierButton tier="WEAK" count={weakRows.length} label="Weak" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <SignalTable rows={weakRows} emptyMessage="No weak signals" faded />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
