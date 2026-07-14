import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AdbDevice, DeviceStatus } from "./types.js";

const execFileAsync = promisify(execFile);
const whatnotPackage = "com.whatnot_mobile";
const baseDisplayWidth = 720;
const baseDisplayHeight = 1604;
const forcedBrightness = "25";
const displayPrepareThrottleMs = 30_000;
const fullscreenPrepareThrottleMs = 60_000;
const lowPowerThrottleMs = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type GiveawayProbeState = "entered" | "panel_open" | "tab_available" | "absent" | "off_stream" | "unknown";
type Rect = { left: number; top: number; right: number; bottom: number };
type ProbeResult = {
  state: GiveawayProbeState;
  target?: { x: number; y: number };
  source: "visual" | "xml";
  detail?: string;
};
export type TapResult = { stdout: string; stderr: string; skipped?: boolean; reason?: string };
export type GiveawayEntryResult = {
  state: GiveawayProbeState;
  action: "none" | "open_tab" | "enter" | "open_tab_then_enter" | "reload_stream";
  tapped: boolean;
  confirmedEntered: boolean;
  detail?: string;
};

const adbExecutable = () => {
  const candidates = [
    join(process.resourcesPath ?? "", "platform-tools", "adb.exe"),
    join(dirname(process.execPath), "resources", "platform-tools", "adb.exe"),
    join(process.cwd(), "adb.exe"),
    join(dirname(process.execPath), "adb.exe"),
    join(process.resourcesPath ?? "", "adb.exe")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "adb";
};

const normalizeStatus = (status: string): DeviceStatus => {
  if (status === "device") return "connected";
  if (status === "unauthorized") return "unauthorized";
  return "offline";
};

const decodeUiText = (text: string): string =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export const hasWinnerPopupText = (text: string): boolean => {
  const nodes = [...text.matchAll(/<node\b[^>]*>/g)].map((match) => match[0]);
  const boundsBottoms = nodes
    .map((node) => node.match(/\bbounds="\[\d+,\d+]\[\d+,(\d+)]"/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const screenMidline = boundsBottoms.length ? Math.max(...boundsBottoms) / 2 : null;

  for (const node of nodes) {
    const label = decodeUiText(
      `${node.match(/\btext="([^"]*)"/)?.[1] ?? ""} ${node.match(/\bcontent-desc="([^"]*)"/)?.[1] ?? ""}`
    )
    .replace(/\s+/g, " ")
    .trim();
    if (!/you\s+won\s+the\s+giveaway/i.test(label)) continue;

    const bounds = node.match(/\bbounds="\[(\d+),(\d+)]\[(\d+),(\d+)]"/);
    if (!bounds || screenMidline === null) continue;
    const top = Number(bounds[2]);
    const bottom = Number(bounds[4]);
    const midpoint = (top + bottom) / 2;
    if (midpoint <= screenMidline) return true;
  }

  return false;
};

export class AdbService {
  private readonly lastDisplayPrepareAt = new Map<string, number>();
  private readonly lastFullscreenPrepareAt = new Map<string, number>();
  private readonly lastLowPowerAt = new Map<string, number>();
  private readonly giveawayBlockedUntil = new Map<string, number>();

  private async shell(deviceId: string, command: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(adbExecutable(), ["-s", deviceId, "shell", ...command], { windowsHide: true });
  }

  private async adbBuffer(args: string[], timeout = 2_500): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        adbExecutable(),
        args,
        { encoding: "buffer", maxBuffer: 12 * 1024 * 1024, timeout, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        }
      );
    });
  }

  private async touch(deviceId: string, x: number, y: number): Promise<{ stdout: string; stderr: string }> {
    const tapX = String(Math.round(x));
    const tapY = String(Math.round(y));
    return execFileAsync(adbExecutable(), ["-s", deviceId, "shell", "input", "tap", tapX, tapY], {
      windowsHide: true
    });
  }

  async listDevices(previous: AdbDevice[]): Promise<AdbDevice[]> {
    try {
      const { stdout } = await execFileAsync(adbExecutable(), ["devices"], { windowsHide: true });
      const selected = new Set(previous.filter((device) => device.selected).map((device) => device.id));

      return stdout
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, status = "offline"] = line.split(/\s+/);
          return {
            id,
            status: normalizeStatus(status),
            label: id,
            selected: selected.size === 0 || selected.has(id)
          };
        });
    } catch {
      return [];
    }
  }

  async tap(deviceId: string, x: number, y: number): Promise<TapResult> {
    return this.touch(deviceId, x, y);
  }

  private async readUiXml(deviceId: string, filename: string, timeout = 2_500): Promise<string> {
    await this.shell(deviceId, ["uiautomator", "dump", `/sdcard/${filename}`]).catch(() => undefined);
    const { stdout } = await execFileAsync(adbExecutable(), ["-s", deviceId, "exec-out", "cat", `/sdcard/${filename}`], {
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024
    }).catch(() => ({ stdout: "", stderr: "" }));
    return String(stdout ?? "");
  }

  async isWinnerPopupVisible(deviceId: string): Promise<{ visible: boolean; detail: string }> {
    const text = await this.readUiXml(deviceId, "nilbog_winner_watch.xml", 1_800).catch(() => "");
    return {
      visible: hasWinnerPopupText(text),
      detail: text ? "winner popup UI text scanned" : "winner popup UI text unavailable"
    };
  }

  private async isGiveawayBlockedPopupVisible(deviceId: string): Promise<{ visible: boolean; detail: string }> {
    const now = Date.now();
    const blockedUntil = this.giveawayBlockedUntil.get(deviceId) ?? 0;
    if (blockedUntil > now) {
      return { visible: true, detail: `giveaway blocked popup cached ${Math.ceil((blockedUntil - now) / 1000)}s` };
    }

    const text = await this.readUiXml(deviceId, "nilbog_giveaway_block_guard.xml", 1_800).catch(() => "");
    if (/You (?:can(?:not|'t)|cant) enter this giveaway/i.test(text.replace(/&apos;/g, "'"))) {
      this.giveawayBlockedUntil.set(deviceId, now + 4_500);
      return { visible: true, detail: "giveaway blocked popup visible" };
    }

    return { visible: false, detail: "no giveaway blocked popup" };
  }

  private parseRawScreencap(buffer: Buffer): { width: number; height: number; data: Buffer; bytesPerPixel: number } | null {
    if (buffer.length < 12) return null;
    const width = buffer.readUInt32LE(0);
    const height = buffer.readUInt32LE(4);
    const pixelBytes = buffer.length - 12;
    const bytesPerPixel = Math.floor(pixelBytes / Math.max(1, width * height));
    if (width < 100 || height < 100 || width > 5000 || height > 5000 || bytesPerPixel < 3) return null;
    return { width, height, data: buffer.subarray(12), bytesPerPixel };
  }

  private colorRatios(
    screen: { width: number; height: number; data: Buffer; bytesPerPixel: number },
    rect: Rect
  ): { white: number; bright: number; dark: number } {
    const left = Math.max(0, Math.min(screen.width - 1, rect.left));
    const right = Math.max(left + 1, Math.min(screen.width, rect.right));
    const top = Math.max(0, Math.min(screen.height - 1, rect.top));
    const bottom = Math.max(top + 1, Math.min(screen.height, rect.bottom));
    let total = 0;
    let white = 0;
    let bright = 0;
    let dark = 0;

    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = (y * screen.width + x) * screen.bytesPerPixel;
        const red = screen.data[index] ?? 0;
        const green = screen.data[index + 1] ?? 0;
        const blue = screen.data[index + 2] ?? 0;
        const avg = (red + green + blue) / 3;
        total += 1;
        if (red > 210 && green > 210 && blue > 210) white += 1;
        if (avg > 160) bright += 1;
        if (avg < 80) dark += 1;
      }
    }

    return {
      white: total ? white / total : 0,
      bright: total ? bright / total : 0,
      dark: total ? dark / total : 0
    };
  }

  private scaleRect(
    screen: { width: number; height: number },
    rect: Rect
  ): Rect {
    const scaleX = screen.width / baseDisplayWidth;
    const scaleY = screen.height / baseDisplayHeight;
    return {
      left: Math.round(rect.left * scaleX),
      top: Math.round(rect.top * scaleY),
      right: Math.round(rect.right * scaleX),
      bottom: Math.round(rect.bottom * scaleY)
    };
  }

  private scalePoint(
    screen: { width: number; height: number },
    point: { x: number; y: number }
  ): { x: number; y: number } {
    return {
      x: Math.round(point.x * (screen.width / baseDisplayWidth)),
      y: Math.round(point.y * (screen.height / baseDisplayHeight))
    };
  }

  private brightComponentTarget(
    screen: { width: number; height: number; data: Buffer; bytesPerPixel: number },
    rect: Rect
  ): { x: number; y: number; detail: string } | null {
    const left = Math.max(0, Math.min(screen.width - 1, rect.left));
    const right = Math.max(left + 1, Math.min(screen.width, rect.right));
    const top = Math.max(0, Math.min(screen.height - 1, rect.top));
    const bottom = Math.max(top + 1, Math.min(screen.height, rect.bottom));
    const width = right - left;
    const height = bottom - top;
    const seen = new Uint8Array(width * height);
    const bright = new Uint8Array(width * height);

    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixelIndex = (y * screen.width + x) * screen.bytesPerPixel;
        const red = screen.data[pixelIndex] ?? 0;
        const green = screen.data[pixelIndex + 1] ?? 0;
        const blue = screen.data[pixelIndex + 2] ?? 0;
        const avg = (red + green + blue) / 3;
        if (avg > 175 || (red > 205 && green > 205 && blue > 205)) {
          bright[(y - top) * width + (x - left)] = 1;
        }
      }
    }

    let best: { count: number; left: number; right: number; top: number; bottom: number } | null = null;
    const queue: Array<[number, number]> = [];

    for (let localY = 0; localY < height; localY += 1) {
      for (let localX = 0; localX < width; localX += 1) {
        const startIndex = localY * width + localX;
        if (!bright[startIndex] || seen[startIndex]) continue;

        let count = 0;
        let minX = localX;
        let maxX = localX;
        let minY = localY;
        let maxY = localY;
        queue.length = 0;
        queue.push([localX, localY]);
        seen[startIndex] = 1;

        while (queue.length) {
          const [x, y] = queue.pop()!;
          count += 1;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);

          for (const [nextX, nextY] of [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1]
          ] as Array<[number, number]>) {
            if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
            const nextIndex = nextY * width + nextX;
            if (!bright[nextIndex] || seen[nextIndex]) continue;
            seen[nextIndex] = 1;
            queue.push([nextX, nextY]);
          }
        }

        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        const looksLikeControl = count >= 35 && componentWidth >= 8 && componentHeight >= 8;
        if (looksLikeControl && (!best || count > best.count)) {
          best = { count, left: minX, right: maxX, top: minY, bottom: maxY };
        }
      }
    }

    if (!best) return null;
    const x = Math.round(left + (best.left + best.right) / 2);
    const y = Math.round(top + (best.top + best.bottom) / 2);
    return {
      x,
      y,
      detail: `component count=${best.count} bounds=[${left + best.left},${top + best.top}][${left + best.right},${top + best.bottom}]`
    };
  }

  private async visualGiveawayProbe(deviceId: string): Promise<ProbeResult | null> {
    const raw = await this.adbBuffer(["-s", deviceId, "exec-out", "screencap"]).catch(() => null);
    if (!raw) return null;
    const screen = this.parseRawScreencap(raw);
    if (!screen) return null;

    const panelRect = this.scaleRect(screen, { left: 40, top: 255, right: 680, bottom: 335 });
    const tabRect = this.scaleRect(screen, { left: 520, top: 120, right: 720, bottom: 360 });
    const enterTarget = this.scalePoint(screen, { x: 360, y: 296 });
    const giveawayPanelTarget = this.scalePoint(screen, { x: 640, y: 216 });
    const panel = this.colorRatios(screen, panelRect);
    const tab = this.colorRatios(screen, tabRect);
    const detail = `screen=${screen.width}x${screen.height} panel white=${panel.white.toFixed(3)} bright=${panel.bright.toFixed(3)} dark=${panel.dark.toFixed(3)} tab white=${tab.white.toFixed(3)} bright=${tab.bright.toFixed(3)}`;

    if (panel.white > 0.45 && panel.bright > 0.5) {
      return { state: "panel_open", target: enterTarget, source: "visual", detail };
    }
    if (panel.white > 0.015 && panel.white < 0.08 && panel.bright < 0.12 && panel.dark > 0.45 && tab.white > 0.015) {
      return { state: "entered", source: "visual", detail };
    }
    if (tab.white > 0.015 && tab.bright > 0.055) {
      const target = this.brightComponentTarget(screen, tabRect);
      const maxTabY = Math.round(340 * (screen.height / baseDisplayHeight));
      if (target && target.y <= maxTabY) {
        return {
          state: "tab_available",
          target: giveawayPanelTarget,
          source: "visual",
          detail: `${detail} detected giveaway panel via ${target.detail}; tapped panel center`
        };
      }
    }
    return { state: "absent", source: "visual", detail };
  }

  private parseBounds(bounds: string): Rect | null {
    const match = bounds.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
    if (!match) return null;
    return {
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[3]),
      bottom: Number(match[4])
    };
  }

  private async xmlGiveawayProbe(deviceId: string): Promise<ProbeResult | null> {
    const text = await this.readUiXml(deviceId, "nilbog_fast_probe.xml").catch(() => "");
    if (!text) return null;
    const isLiveStreamScreen =
      /resource-id="liveBuyerVerticalPager"/i.test(text) ||
      /text="Say something/i.test(text) ||
      /text="Bid\s/i.test(text) ||
      /resource-id="storeButton"/i.test(text);

    if (/You(?:'re| are) in the Giveaway/i.test(text)) {
      return { state: "entered", source: "xml", detail: "entered text found" };
    }

    const nodes = [...text.matchAll(/<node\b[^>]*>/g)].map((match) => match[0]);
    let bestEnter: { rect: Rect; area: number } | null = null;
    let bestGiveawayTab: { rect: Rect; area: number } | null = null;

    for (const node of nodes) {
      const textMatch = node.match(/\btext="([^"]*)"/);
      const descMatch = node.match(/\bcontent-desc="([^"]*)"/);
      const label = `${textMatch?.[1] ?? ""} ${descMatch?.[1] ?? ""}`.replace(/&amp;/g, "&");
      const boundsMatch = node.match(/\bbounds="([^"]+)"/);
      const rect = boundsMatch ? this.parseBounds(boundsMatch[1]) : null;
      const width = rect ? rect.right - rect.left : 0;
      const height = rect ? rect.bottom - rect.top : 0;
      const area = width * height;
      if (rect && /Giveaway/i.test(label) && rect.left >= 480 && rect.top >= 80 && rect.top <= 360 && area >= 400) {
        if (!bestGiveawayTab || area < bestGiveawayTab.area) bestGiveawayTab = { rect, area };
      }
      if (!rect || !/Enter Giveaway/i.test(label)) continue;

      const isLikelyButton = rect.top >= 220 && rect.top <= 380 && width > 80 && height > 25;
      if (!isLikelyButton) continue;
      if (!bestEnter || area < bestEnter.area) bestEnter = { rect, area };
    }

    if (bestEnter) {
      return {
        state: "panel_open",
        target: {
          x: Math.round((bestEnter.rect.left + bestEnter.rect.right) / 2),
          y: Math.round((bestEnter.rect.top + bestEnter.rect.bottom) / 2)
        },
        source: "xml",
        detail: "enter giveaway node found"
      };
    }
    if (bestGiveawayTab) {
      return {
        state: "tab_available",
        target: {
          x: Math.round((bestGiveawayTab.rect.left + bestGiveawayTab.rect.right) / 2),
          y: Math.round((bestGiveawayTab.rect.top + bestGiveawayTab.rect.bottom) / 2)
        },
        source: "xml",
        detail: "giveaway tab node bounds found"
      };
    }
    if (!isLiveStreamScreen) {
      return { state: "off_stream", source: "xml", detail: "not on live stream screen" };
    }
    return { state: "absent", source: "xml", detail: "live stream screen; no giveaway marker found" };
  }

  private async giveawayProbe(deviceId: string): Promise<ProbeResult> {
    const visual = await this.visualGiveawayProbe(deviceId);
    if (visual && visual.state !== "absent") return visual;

    const xml = await this.xmlGiveawayProbe(deviceId);
    if (xml) return xml;

    return (
      visual ?? {
        state: "unknown",
        source: "visual",
        detail: "probe unavailable"
      }
    );
  }

  async enterGiveawayFast(deviceId: string, streamUrl: string | null = null): Promise<GiveawayEntryResult> {
    await this.prepareControlDisplay(deviceId);
    const first = await this.giveawayProbe(deviceId);

    if (first.state === "off_stream" && streamUrl) {
      await this.openUrl(deviceId, streamUrl);
      await this.prepareFullscreenWhatnot(deviceId);
      return {
        state: "off_stream",
        action: "reload_stream",
        tapped: false,
        confirmedEntered: false,
        detail: `${first.source}: ${first.detail ?? ""}; reloaded ${streamUrl}`
      };
    }

    if (first.state === "entered") {
      return { state: "entered", action: "none", tapped: false, confirmedEntered: true, detail: `${first.source}: ${first.detail ?? ""}` };
    }

    if (first.state === "panel_open" && first.target) {
      await this.touch(deviceId, first.target.x, first.target.y);
      await sleep(180);
      const confirm = await this.giveawayProbe(deviceId);
      return {
        state: confirm.state,
        action: "enter",
        tapped: true,
        confirmedEntered: confirm.state === "entered",
        detail: `${first.source}: tapped enter ${first.target.x},${first.target.y}; confirm ${confirm.source}: ${confirm.detail ?? ""}`
      };
    }

    if (first.state === "tab_available" && first.target) {
      await this.touch(deviceId, first.target.x, first.target.y);
      await sleep(220);
      const second = await this.giveawayProbe(deviceId);
      if (second.state === "panel_open" && second.target) {
        await this.touch(deviceId, second.target.x, second.target.y);
        await sleep(180);
        const confirm = await this.giveawayProbe(deviceId);
        return {
          state: confirm.state,
          action: "open_tab_then_enter",
          tapped: true,
          confirmedEntered: confirm.state === "entered",
          detail: `${first.source}: opened tab ${first.target.x},${first.target.y}; ${second.source}: tapped enter ${second.target.x},${second.target.y}; confirm ${confirm.source}: ${confirm.detail ?? ""}`
        };
      }
      return {
        state: second.state,
        action: "open_tab",
        tapped: true,
        confirmedEntered: second.state === "entered",
        detail: `${first.source}: opened tab ${first.target.x},${first.target.y}; ${second.source}: ${second.detail ?? ""}`
      };
    }

    return {
      state: first.state,
      action: "none",
      tapped: false,
      confirmedEntered: false,
      detail: `${first.source}: ${first.detail ?? ""}`
    };
  }

  async openUrl(deviceId: string, url: string): Promise<void> {
    await this.prepareControlDisplay(deviceId);
    await execFileAsync(adbExecutable(), ["-s", deviceId, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], {
      windowsHide: true
    });
  }

  async openUrlFresh(deviceId: string, url: string): Promise<void> {
    await this.shell(deviceId, ["am", "force-stop", whatnotPackage]).catch(() => undefined);
    await this.openUrl(deviceId, url);
  }

  async launchWhatnot(deviceId: string): Promise<void> {
    await this.prepareControlDisplay(deviceId);
    await this.shell(deviceId, ["monkey", "-p", whatnotPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  }

  async closeWhatnot(deviceId: string): Promise<void> {
    await this.shell(deviceId, ["am", "force-stop", whatnotPackage]).catch(() => undefined);
  }

  async parkWhatnotOnHome(deviceId: string): Promise<{ foregroundPackage: string | null }> {
    await this.prepareControlDisplay(deviceId);
    await this.shell(deviceId, ["am", "force-stop", whatnotPackage]).catch(() => undefined);
    await this.shell(deviceId, ["am", "kill", whatnotPackage]).catch(() => undefined);
    await sleep(150);
    await this.goHome(deviceId);
    const foregroundPackage = await this.getForegroundPackage(deviceId).catch(() => null);
    return { foregroundPackage };
  }

  async goHome(deviceId: string): Promise<void> {
    await this.shell(deviceId, ["input", "keyevent", "KEYCODE_HOME"]).catch(() => undefined);
    await sleep(250);
    await this.shell(deviceId, ["input", "keyevent", "KEYCODE_HOME"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "statusbar", "collapse"]).catch(() => undefined);
  }

  async rebootDevice(deviceId: string): Promise<void> {
    await execFileAsync(adbExecutable(), ["-s", deviceId, "reboot"], { windowsHide: true });
  }

  async restartWhatnot(deviceId: string, preferredUrl: string | null): Promise<void> {
    await this.prepareControlDisplay(deviceId, true);
    await this.shell(deviceId, ["am", "force-stop", whatnotPackage]).catch(() => undefined);
    await sleep(900);
    if (preferredUrl) {
      await this.openUrl(deviceId, preferredUrl);
    } else {
      await this.launchWhatnot(deviceId);
    }
    await this.prepareFullscreenWhatnot(deviceId);
  }

  async getForegroundPackage(deviceId: string): Promise<string | null> {
    const activity = await this.shell(deviceId, ["dumpsys", "activity", "activities"]).catch(() => ({ stdout: "", stderr: "" }));
    const activityMatch = activity.stdout.match(/(?:topResumedActivity|mResumedActivity):.*?\s([a-zA-Z0-9_.]+)\/[^\s}]+/);
    if (activityMatch?.[1]) return activityMatch[1];

    const window = await this.shell(deviceId, ["dumpsys", "window"]).catch(() => ({ stdout: "", stderr: "" }));
    const windowMatch = window.stdout.match(/(?:mCurrentFocus|mFocusedApp)=.*?\s([a-zA-Z0-9_.]+)\/[^\s}]+/);
    return windowMatch?.[1] ?? null;
  }

  async getCurrentWhatnotStreamUuid(deviceId: string): Promise<string | null> {
    const outputs = await Promise.all([
      this.shell(deviceId, ["dumpsys", "activity", "top"]).catch(() => ({ stdout: "", stderr: "" })),
      this.shell(deviceId, ["dumpsys", "activity", "activities"]).catch(() => ({ stdout: "", stderr: "" }))
    ]);
    for (const output of outputs) {
      const match = output.stdout.match(/whatnot\.com\/live\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (match?.[1]) return match[1].toLowerCase();
    }
    return null;
  }

  async prepareFullscreenWhatnot(deviceId: string, force = false): Promise<void> {
    const now = Date.now();
    const lastPreparedAt = this.lastFullscreenPrepareAt.get(deviceId) ?? 0;
    if (!force && now - lastPreparedAt < fullscreenPrepareThrottleMs) return;
    await this.prepareControlDisplay(deviceId);
    await this.shell(deviceId, ["input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => undefined);
    await this.shell(deviceId, ["wm", "dismiss-keyguard"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "appops", "set", whatnotPackage, "PICTURE_IN_PICTURE", "ignore"]).catch(() => undefined);
    await this.shell(deviceId, ["appops", "set", whatnotPackage, "PICTURE_IN_PICTURE", "ignore"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "global", "policy_control", `immersive.full=${whatnotPackage}`]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "statusbar", "collapse"]).catch(() => undefined);
    this.lastFullscreenPrepareAt.set(deviceId, now);
  }

  private async enforceLowPowerControls(deviceId: string, force = false): Promise<void> {
    const now = Date.now();
    const lastAppliedAt = this.lastLowPowerAt.get(deviceId) ?? 0;
    if (!force && now - lastAppliedAt < lowPowerThrottleMs) return;

    await this.shell(deviceId, ["settings", "put", "system", "screen_brightness_mode", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "screen_brightness", forcedBrightness]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "volume_music_speaker", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "volume_music_headset", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "audio", "set-volume", "stream_music", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "audio", "set-volume", "stream_ring", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "audio", "set-volume", "stream_notification", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "audio", "set-volume", "stream_system", "0"]).catch(() => undefined);
    this.lastLowPowerAt.set(deviceId, now);
  }

  async prepareControlDisplay(deviceId: string, force = false): Promise<void> {
    const now = Date.now();
    const lastPreparedAt = this.lastDisplayPrepareAt.get(deviceId) ?? 0;
    if (!force && now - lastPreparedAt < displayPrepareThrottleMs) return;

    await this.shell(deviceId, ["input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => undefined);
    await this.shell(deviceId, ["wm", "size", "reset"]).catch(() => undefined);
    await this.shell(deviceId, ["wm", "density", "reset"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "accelerometer_rotation", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "user_rotation", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "secure", "accessibility_display_magnification_enabled", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "secure", "accessibility_display_magnification_navbar_enabled", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "secure", "accessibility_display_magnification_scale", "1.0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "secure", "accessibility_magnification_enabled", "0"]).catch(() => undefined);
    await this.shell(deviceId, ["settings", "put", "system", "screen_off_timeout", "2147483647"]).catch(() => undefined);
    await this.shell(deviceId, ["cmd", "appops", "set", whatnotPackage, "PICTURE_IN_PICTURE", "ignore"]).catch(() => undefined);
    await this.shell(deviceId, ["appops", "set", whatnotPackage, "PICTURE_IN_PICTURE", "ignore"]).catch(() => undefined);
    await this.shell(deviceId, ["svc", "power", "stayon", "true"]).catch(() => undefined);
    await this.enforceLowPowerControls(deviceId, force);
    this.lastDisplayPrepareAt.set(deviceId, now);
  }

  async ensureWhatnotForeground(deviceId: string, preferredUrl: string | null, forceDisplay = false): Promise<{ changed: boolean; foregroundPackage: string | null }> {
    const foregroundPackage = await this.getForegroundPackage(deviceId);
    if (foregroundPackage === whatnotPackage) {
      if (forceDisplay) {
        await this.prepareFullscreenWhatnot(deviceId);
      }
      return { changed: false, foregroundPackage };
    }

    if (forceDisplay) {
      await this.prepareControlDisplay(deviceId, true);
    }
    if (preferredUrl) {
      await this.openUrl(deviceId, preferredUrl);
    } else {
      await this.launchWhatnot(deviceId);
    }
    await this.prepareFullscreenWhatnot(deviceId);
    await this.shell(deviceId, ["cmd", "statusbar", "collapse"]).catch(() => undefined);
    return { changed: true, foregroundPackage };
  }

  async getScreenInfo(deviceId: string): Promise<string> {
    const [size, density] = await Promise.all([
      execFileAsync(adbExecutable(), ["-s", deviceId, "shell", "wm", "size"], { windowsHide: true }).catch(() => ({ stdout: "", stderr: "" })),
      execFileAsync(adbExecutable(), ["-s", deviceId, "shell", "wm", "density"], { windowsHide: true }).catch(() => ({ stdout: "", stderr: "" }))
    ]);
    return `${size.stdout.trim()} ${density.stdout.trim()}`.trim();
  }

  async killServer(): Promise<void> {
    await execFileAsync(adbExecutable(), ["kill-server"], { windowsHide: true }).catch(() => undefined);
  }
}
