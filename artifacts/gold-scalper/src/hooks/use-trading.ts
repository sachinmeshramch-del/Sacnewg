import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetPrice, 
  useGetSignal, 
  useGetHistory, 
  useConfigureTelegram, 
  useGetTelegramStatus,
  getGetTelegramStatusQueryKey
} from "@workspace/api-client-react";

// Wrapper hooks to inject global refetch intervals for the dashboard

export function useLivePrice() {
  return useGetPrice({
    query: {
      refetchInterval: 10000, // still poll REST for high/low/change context
      staleTime: 5000,
    }
  });
}

export function useCurrentSignal(timeframe: "1m" | "5m") {
  return useGetSignal({ timeframe }, {
    query: {
      refetchInterval: 10000, // 10 seconds — matches backend cache TTL
      staleTime: 5000,
    }
  });
}

export function useSignalHistory() {
  return useGetHistory({
    query: {
      refetchInterval: 15000, // 15 seconds
      staleTime: 10000,
    }
  });
}

export function useTelegramStatus() {
  return useGetTelegramStatus({
    query: {
      staleTime: 5 * 60 * 1000, // 5 mins
    }
  });
}

export function useSetupTelegram() {
  const queryClient = useQueryClient();
  
  return useConfigureTelegram({
    mutation: {
      onSuccess: () => {
        // Invalidate status query when configuration changes
        queryClient.invalidateQueries({ queryKey: getGetTelegramStatusQueryKey() });
      }
    }
  });
}
