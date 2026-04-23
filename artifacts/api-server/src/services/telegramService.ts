interface TelegramConfig {
  botToken: string;
  chatId: string;
}

let telegramConfig: TelegramConfig | null = null;

export function setTelegramConfig(config: TelegramConfig) {
  telegramConfig = config;
}

export function getTelegramConfig(): TelegramConfig | null {
  return telegramConfig;
}

export async function sendTelegramAlert(
  signal: "BUY" | "SELL",
  entry: number,
  stopLoss: number,
  takeProfit: number,
  confidence: number
): Promise<void> {
  if (!telegramConfig) return;

  const { botToken, chatId } = telegramConfig;
  const emoji = signal === "BUY" ? "🟢" : "🔴";
  const message = `${emoji} GOLD SCALPING SIGNAL\n\nPair: XAUUSD\nSignal: ${signal}\nEntry: $${entry.toFixed(2)}\nStop Loss: $${stopLoss.toFixed(2)}\nTake Profit: $${takeProfit.toFixed(2)}\nConfidence: ${confidence}%`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Failed to send Telegram alert:", err);
  }
}
