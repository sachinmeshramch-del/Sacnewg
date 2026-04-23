import { useSignalHistory } from "@/hooks/use-trading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { History, CheckCircle2, XCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export function SignalHistory() {
  const { data, isLoading } = useSignalHistory();

  return (
    <Card className="border-white/10 bg-card/80 backdrop-blur-xl h-full flex flex-col">
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium text-muted-foreground">Recent Signals</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0 relative">
        {isLoading ? (
          <div className="p-6 space-y-4 animate-pulse">
            {[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-white/5 rounded-md" />)}
          </div>
        ) : !data || data.signals.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center h-full">
            <Clock className="h-8 w-8 mb-3 opacity-50" />
            <p>No trading history available</p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[400px]">
            <Table>
              <TableHeader className="bg-secondary/50 sticky top-0 backdrop-blur-md z-10 border-b border-white/5">
                <TableRow className="hover:bg-transparent border-white/5">
                  <TableHead className="text-xs">Time</TableHead>
                  <TableHead className="text-xs">TF</TableHead>
                  <TableHead className="text-xs">Signal</TableHead>
                  <TableHead className="text-xs text-right">Entry</TableHead>
                  <TableHead className="text-xs text-right">SL</TableHead>
                  <TableHead className="text-xs text-right">TP</TableHead>
                  <TableHead className="text-xs text-center">Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.signals.map((trade) => (
                  <TableRow key={trade.id} className="border-white/5 hover:bg-white/[0.02]">
                    <TableCell className="text-xs font-numbers text-muted-foreground whitespace-nowrap">
                      {format(new Date(trade.timestamp), "MMM dd, HH:mm")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {trade.timeframe}
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider",
                        trade.signal === 'BUY' ? "bg-success/20 text-success" :
                        trade.signal === 'SELL' ? "bg-destructive/20 text-destructive" :
                        "bg-warning/20 text-warning"
                      )}>
                        {trade.signal}
                      </span>
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
                      {trade.outcome === 'WIN' ? (
                        <Badge variant="outline" className="bg-success/10 text-success border-success/20 py-0 text-[10px]">WIN</Badge>
                      ) : trade.outcome === 'LOSS' ? (
                        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 py-0 text-[10px]">LOSS</Badge>
                      ) : (
                        <Badge variant="outline" className="bg-white/5 text-muted-foreground border-white/10 py-0 text-[10px]">PENDING</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
