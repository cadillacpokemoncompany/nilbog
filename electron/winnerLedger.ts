import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GiveawayWinnerState } from "./types.js";

interface WinnerEntry {
  key: string;
  stream: string;
  streamId: string;
  giveaway: string;
  winner: string;
  wonAt: string;
}

interface WinnerLedgerState {
  entries: WinnerEntry[];
  reportedCount: number;
  scope: "all" | "tapped";
}

const WINNER_REPORT_SIZE = 10;

export class WinnerLedger {
  private state: WinnerLedgerState = { entries: [], reportedCount: 0, scope: "tapped" };
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(
    appDataDir: string,
    private readonly sendReport: (entries: WinnerEntry[]) => Promise<boolean>,
    private readonly logger: (message: string, error?: unknown) => void | Promise<void>
  ) {
    this.path = join(appDataDir, "nilbog-winner-ledger.json");
  }

  async load(): Promise<void> {
    const parsed = await readFile(this.path, "utf8")
      .then((text) => JSON.parse(text) as Partial<WinnerLedgerState>)
      .catch(() => null);
    if (parsed && Array.isArray(parsed.entries)) {
      this.state = {
        entries: parsed.entries as WinnerEntry[],
        reportedCount: Math.max(0, Number(parsed.reportedCount) || 0),
        scope: parsed.scope === "tapped" ? "tapped" : "all"
      };
    }
    if (this.state.scope !== "tapped") {
      this.state.reportedCount = this.state.entries.length;
      this.state.scope = "tapped";
      await this.save();
    }
    await this.flushReports();
  }

  record(stream: string, streamId: string, winner: GiveawayWinnerState): void {
    this.queue = this.queue.then(async () => {
      const key = `${streamId}:${winner.giveawayId}`.toLowerCase();
      if (this.state.entries.some((entry) => entry.key === key)) return;
      this.state.entries.push({ key, stream, streamId, giveaway: winner.prizeName, winner: winner.winnerUsername, wonAt: winner.wonAt });
      await this.save();
      await this.flushReports();
    }).catch((error) => this.logger("winner ledger record failed", error));
  }

  private async flushReports(): Promise<void> {
    while (this.state.entries.length - this.state.reportedCount >= WINNER_REPORT_SIZE) {
      const batch = this.state.entries.slice(this.state.reportedCount, this.state.reportedCount + WINNER_REPORT_SIZE)
        .sort((left, right) => Date.parse(left.wonAt) - Date.parse(right.wonAt));
      if (!await this.sendReport(batch)) return;
      this.state.reportedCount += WINNER_REPORT_SIZE;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temporary, this.path);
  }
}
