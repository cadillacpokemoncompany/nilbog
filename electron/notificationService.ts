export type DiscordAlertKind = "navigation" | "entry" | "win" | "parking" | "info";

const alertStyles: Record<DiscordAlertKind, { label: string; color: number }> = {
  navigation: { label: "NAVIGATION", color: 0x9b59b6 },
  entry: { label: "ENTRY", color: 0xf39c12 },
  win: { label: "WIN", color: 0x2ecc71 },
  parking: { label: "PARKING", color: 0xe74c3c },
  info: { label: "ALERT", color: 0x95a5a6 }
};

const cleanLine = (value: string): string => value.replace(/[^\S\r\n]+/g, " ").trim();

const cleanBlock = (value: string): string =>
  value
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)
    .join("\n")
    .toUpperCase();

const discordTimeoutMs = 8_000;
const discordMaxAttempts = 3;

export class NotificationService {
  private readonly webhookUrl: string;

  constructor(
    private readonly logger: (message: string, error?: unknown) => void | Promise<void>,
    webhookUrl = process.env.NILBOG_DISCORD_WEBHOOK ?? ""
  ) {
    this.webhookUrl = webhookUrl.trim();
  }

  async sendAlert(kind: DiscordAlertKind, streamName: string, occurred: string): Promise<void> {
    const style = alertStyles[kind] ?? alertStyles.info;
    const stream = cleanBlock(streamName || "Unknown stream");
    const detail = cleanBlock(occurred || "No detail");
    await this.post({
      embeds: [
        {
          color: style.color,
          description: [style.label, stream, detail].join("\n\n"),
          timestamp: new Date().toISOString()
        }
      ]
    });
  }

  async send(message: string): Promise<void> {
    const content = message.replace(/\s+/g, " ").trim();
    if (!this.webhookUrl || !content) return;
    await this.post({ content });
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) return;
    const body = JSON.stringify({
      username: "Nilbog",
      ...payload
    });

    for (let attempt = 1; attempt <= discordMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), discordTimeoutMs);
      try {
        const response = await fetch(this.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body,
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (response.ok) {
          await this.logger(`discord notification sent status=${response.status} attempt=${attempt}`);
          return;
        }

        const responseText = await response.text().catch(() => "");
        await this.logger(`discord notification failed status=${response.status} attempt=${attempt} body=${responseText.slice(0, 300)}`);
      } catch (error) {
        clearTimeout(timeout);
        await this.logger(`discord notification failed attempt=${attempt}`, error);
      }

      if (attempt < discordMaxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
      }
    }
  }
}
