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

const reportLine = (value: string): string => {
  const cleaned = cleanBlock(value || "UNKNOWN").replace(/\s+/g, " ");
  return cleaned.length > 20 ? `${cleaned.slice(0, 17)}...` : cleaned;
};

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
    const description = (() => {
      if (kind === "navigation") {
        const rawLines = occurred
          .split(/\r?\n/)
          .map(cleanLine)
          .filter(Boolean);
        const reason = rawLines[0]?.replace(/^Navigated due to\s+/i, "").replace(/^"|"$/g, "") || "MATCH FOUND";
        const giveaway = rawLines.find((line) => !/^Navigated due to/i.test(line) && !/^Routed\b/i.test(line));
        return [
          `NAVIGATED TO ${stream} STREAM`,
          giveaway ? `BEGAN ENTERING: ${cleanBlock(giveaway)}` : "BEGAN ENTERING",
          `WHY: ${cleanBlock(reason)}`
        ].join("\n\n");
      }

      if (kind === "entry") {
        const rawLines = occurred
          .split(/\r?\n/)
          .map(cleanLine)
          .filter(Boolean);
        const giveaway = rawLines.find((line) => !/^Entered giveaway/i.test(line) && !/^Tapped\b/i.test(line));
        return [`ENTERING ${stream}`, giveaway ? cleanBlock(giveaway) : "GIVEAWAY TAP SENT"].join("\n\n");
      }

      return [style.label, stream, detail].join("\n\n");
    })();
    await this.post({
      embeds: [
        {
          color: style.color,
          description,
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

  async sendWinnerReport(entries: Array<{ stream: string; giveaway: string; winner: string }>): Promise<boolean> {
    if (!this.webhookUrl || entries.length === 0) return false;
    const blocks = entries.map((entry) => [
      `STREAM: ${reportLine(entry.stream)}`,
      `GIVEAWAY: ${reportLine(entry.giveaway)}`,
      `WINNER: ${reportLine(entry.winner)}`
    ].join("\n"));
    const parts: string[] = [];
    let current = "";
    for (const block of blocks) {
      const trimmed = block.slice(0, 900);
      const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
      if (candidate.length > 3_700 && current) {
        parts.push(current);
        current = trimmed;
      } else {
        current = candidate;
      }
    }
    if (current) parts.push(current);
    for (let index = 0; index < parts.length; index += 1) {
      const sent = await this.post({ embeds: [{
        color: alertStyles.win.color,
        title: `10 WIN REPORT${parts.length > 1 ? ` - PART ${index + 1}/${parts.length}` : ""}`,
        description: parts[index],
        timestamp: new Date().toISOString()
      }] });
      if (!sent) return false;
    }
    return true;
  }

  private async post(payload: Record<string, unknown>): Promise<boolean> {
    if (!this.webhookUrl) return false;
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
          return true;
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
    return false;
  }
}
