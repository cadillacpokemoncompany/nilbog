import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { UpdateHealth } from "./types.js";

export interface UpdateManifest {
  version: string;
  installer: string;
  sha256?: string;
  notes?: string;
  publishedAt?: string;
}

interface AutoUpdaterOptions {
  userDataPath: string;
  currentVersion: string;
  logger: (message: string, error?: unknown) => void | Promise<void>;
  canInstall: () => boolean;
  onStatus?: (message: string) => void | Promise<void>;
  onHealth?: (patch: Partial<UpdateHealth>) => void | Promise<void>;
  onBeforeInstall: (installerPath: string, manifest: UpdateManifest) => Promise<void>;
  quit: () => void;
}

const UPDATE_CHECK_MS = 5 * 60_000;
const GITHUB_UPDATE_MANIFEST_URL =
  "https://github.com/cadillacpokemoncompany/nilbog/releases/latest/download/latest.json";

const parseVersion = (value: string): number[] =>
  value
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

const compareVersions = (left: string, right: string): number => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

const sha256File = async (path: string): Promise<string> => {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
};

type UpdateSource =
  | { kind: "url"; manifestUrl: string }
  | { kind: "directory"; sourcePath: string };

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

const readUrlText = async (url: string): Promise<string | null> => {
  const response = await fetch(url, {
    headers: {
      "cache-control": "no-cache"
    }
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.text();
};

const downloadUrlToFile = async (url: string, path: string): Promise<boolean> => {
  const response = await fetch(url, {
    headers: {
      "cache-control": "no-cache"
    }
  }).catch(() => null);
  if (!response?.ok) return false;
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(path, data);
  return true;
};

export class AutoUpdaterService {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private pendingManifest: UpdateManifest | null = null;
  private pendingInstallerPath: string | null = null;

  constructor(private readonly options: AutoUpdaterOptions) {}

  private async updateHealth(patch: Partial<UpdateHealth>): Promise<void> {
    await this.options.onHealth?.({
      currentVersion: this.options.currentVersion,
      ...patch
    });
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), UPDATE_CHECK_MS);
    setTimeout(() => void this.check(), 20_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.updateHealth({
        status: "checking",
        lastCheckedAt: new Date().toISOString(),
        lastError: null
      });
      if (this.pendingManifest && this.pendingInstallerPath) {
        await this.installIfIdle(this.pendingInstallerPath, this.pendingManifest);
        return;
      }

      const source = await this.resolveSource();
      if (!source) {
        await this.updateHealth({
          status: "disabled",
          lastError: "No update source configured"
        });
        await this.options.logger("auto update skipped: no update source configured");
        return;
      }

      const manifestLocation = source.kind === "url" ? source.manifestUrl : join(source.sourcePath, "latest.json");
      const manifestText =
        source.kind === "url"
          ? await readUrlText(manifestLocation)
          : await readFile(manifestLocation, "utf8").catch(() => null);
      if (!manifestText) {
        await this.updateHealth({
          status: "error",
          lastError: `No latest.json at ${manifestLocation}`
        });
        await this.options.logger(`auto update skipped: no latest.json at ${manifestLocation}`);
        return;
      }

      const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, "")) as Partial<UpdateManifest>;
      if (!manifest.version || !manifest.installer) {
        await this.updateHealth({
          status: "error",
          lastError: `Invalid manifest at ${manifestLocation}`
        });
        await this.options.logger(`auto update skipped: invalid manifest at ${manifestLocation}`);
        return;
      }

      const currentVersion = this.options.currentVersion;
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        await this.updateHealth({
          status: "current",
          latestVersion: manifest.version,
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          pendingInstaller: null
        });
        await this.options.logger(`auto update current version=${currentVersion}; latest=${manifest.version}`);
        return;
      }

      await this.updateHealth({
        status: "available",
        latestVersion: manifest.version,
        lastError: null
      });
      const downloadDir = join(tmpdir(), "NilbogLiteUpdates");
      await mkdir(downloadDir, { recursive: true });
      let localInstaller: string;

      if (source.kind === "url") {
        const installerUrl = isHttpUrl(manifest.installer)
          ? manifest.installer
          : new URL(manifest.installer, manifestLocation).toString();
        localInstaller = join(downloadDir, basename(new URL(installerUrl).pathname) || `NilbogLite Setup ${manifest.version}.exe`);
        const downloaded = await downloadUrlToFile(installerUrl, localInstaller);
        if (!downloaded) {
          await this.updateHealth({
            status: "error",
            latestVersion: manifest.version,
            lastError: `Installer download failed ${installerUrl}`
          });
          await this.options.logger(`auto update skipped: installer download failed ${installerUrl}`);
          return;
        }
      } else {
        const sourceInstaller = isAbsolute(manifest.installer)
          ? manifest.installer
          : resolve(source.sourcePath, manifest.installer);
        const sourceStat = await stat(sourceInstaller).catch(() => null);
        if (!sourceStat?.isFile()) {
          await this.updateHealth({
            status: "error",
            latestVersion: manifest.version,
            lastError: `Installer missing ${sourceInstaller}`
          });
          await this.options.logger(`auto update skipped: installer missing ${sourceInstaller}`);
          return;
        }
        localInstaller = join(downloadDir, basename(sourceInstaller));
        await copyFile(sourceInstaller, localInstaller);
      }

      if (manifest.sha256) {
        const actualHash = await sha256File(localInstaller);
        if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
          await this.updateHealth({
            status: "error",
            latestVersion: manifest.version,
            lastError: `Update hash mismatch for ${localInstaller}`
          });
          await this.options.logger(`auto update hash mismatch for ${localInstaller}`);
          return;
        }
      }

      await this.updateHealth({
        status: "downloaded",
        latestVersion: manifest.version,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        pendingInstaller: localInstaller
      });
      await this.options.logger(`auto update downloaded version=${manifest.version} installer=${localInstaller}`);
      this.pendingManifest = manifest as UpdateManifest;
      this.pendingInstallerPath = localInstaller;
      await this.installIfIdle(localInstaller, manifest as UpdateManifest);
    } catch (error) {
      await this.updateHealth({
        status: "error",
        lastError: error instanceof Error ? error.message : String(error)
      });
      await this.options.logger("auto update check failed", error);
    } finally {
      this.checking = false;
    }
  }

  private async installIfIdle(installerPath: string, manifest: UpdateManifest): Promise<void> {
    if (!this.options.canInstall()) {
      await this.updateHealth({
        status: "pending",
        latestVersion: manifest.version,
        pendingInstaller: installerPath,
        lastError: null
      });
      await this.options.onStatus?.(`Update ${manifest.version} ready; waiting for clicker to stop`);
      await this.options.logger(`auto update pending version=${manifest.version}; clicker is running`);
      return;
    }

    await this.updateHealth({
      status: "installing",
      latestVersion: manifest.version,
      pendingInstaller: installerPath,
      lastError: null
    });
    await this.options.onStatus?.(`Installing update ${manifest.version}`);
    await this.options.logger(`auto update installing version=${manifest.version} from ${installerPath}`);
    await this.options.onBeforeInstall(installerPath, manifest);
    spawn(installerPath, ["/S"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    this.options.quit();
  }

  private async resolveSource(): Promise<UpdateSource | null> {
    const candidates = [
      process.env.NILBOG_UPDATE_URL,
      process.env.NILBOG_UPDATE_SHARE,
      await readFile(join(this.options.userDataPath, "nilbog-update-source.txt"), "utf8").catch(() => null),
      GITHUB_UPDATE_MANIFEST_URL,
      "\\\\LAPTOP-O427DMDT\\NilbogUpdates",
      "\\\\192.168.1.90\\NilbogUpdates",
      "C:\\NilbogUpdates"
    ];

    for (const candidate of candidates) {
      const trimmed = candidate?.trim();
      if (!trimmed) continue;
      const resolved = trimmed.replace(/^"|"$/g, "");
      if (isHttpUrl(resolved)) return { kind: "url", manifestUrl: resolved };
      const stats = await stat(resolved).catch(() => null);
      if (stats?.isDirectory()) return { kind: "directory", sourcePath: resolved };
    }

    return null;
  }
}
