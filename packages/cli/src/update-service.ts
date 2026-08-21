import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { withNetworkErrors } from "./network-error.js";
import { networkFetch } from "./network-fetch.js";
import type { UpdateChannel } from "./update-state.js";
import { processIsAlive } from "./update-lock.js";

const PACKAGE_NAME = "@ariobarin/glossa";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/@ariobarin%2Fglossa";
const DEFAULT_RELEASE_BASE_URL =
  "https://github.com/ariobarin/glossa/releases/download";

export type GlossaDistribution = "npm" | "standalone";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  channel: UpdateChannel;
  updateAvailable: boolean;
}

export interface CheckUpdateOptions {
  fetchImpl?: typeof fetch;
  registryUrl?: string;
  signal?: AbortSignal;
}

export interface InstallUpdateOptions {
  fetchImpl?: typeof fetch;
  releaseBaseUrl?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  executablePath?: string;
}

export interface CleanupUpdateOptions {
  platform?: NodeJS.Platform;
  executablePath?: string;
}

function backupOwnerPid(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const separator = name.indexOf("-", prefix.length);
  if (separator < 0) return null;
  const pid = Number(name.slice(prefix.length, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export type InstallUpdateResult = "installed";

function distTag(channel: UpdateChannel): "beta" | "latest" {
  return channel === "beta" ? "beta" : "latest";
}

export async function checkForUpdate(
  currentVersion: string,
  channel: UpdateChannel,
  options: CheckUpdateOptions = {},
): Promise<UpdateInfo> {
  const normalizedCurrent = semver.valid(currentVersion);
  if (!normalizedCurrent) throw new Error(`Glossa version ${currentVersion} is invalid.`);

  const response = await withNetworkErrors(
    async () => await (options.fetchImpl ?? networkFetch)(
      options.registryUrl ?? process.env.GLOSSA_NPM_REGISTRY_URL ?? DEFAULT_REGISTRY_URL,
      {
        headers: { Accept: "application/json", "User-Agent": `glossa/${currentVersion}` },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    ),
    "the Glossa update service",
  );
  if (!response.ok) {
    throw new Error(`The Glossa update service returned HTTP ${response.status}.`);
  }

  const metadata = await response.json() as { "dist-tags"?: Record<string, unknown> };
  const tag = distTag(channel);
  const candidate = metadata["dist-tags"]?.[tag];
  if (typeof candidate !== "string") {
    if (channel === "stable") {
      throw new Error("No stable Glossa release is published yet.");
    }
    throw new Error("No Glossa beta release is published yet.");
  }
  const availableVersion = semver.valid(candidate);
  if (!availableVersion) {
    throw new Error(`The ${tag} Glossa release has an invalid version.`);
  }
  if (channel === "stable" && semver.prerelease(availableVersion) !== null) {
    throw new Error("No stable Glossa release is published yet.");
  }

  return {
    currentVersion: normalizedCurrent,
    availableVersion,
    channel,
    updateAvailable: semver.gt(availableVersion, normalizedCurrent),
  };
}

export function standaloneAssetName(
  platform: NodeJS.Platform,
  architecture: string,
): string {
  const key = `${platform}-${architecture}`;
  const assets: Record<string, string> = {
    "win32-x64": "glossa-windows-x64.exe",
    "win32-arm64": "glossa-windows-arm64.exe",
    "linux-x64": "glossa-linux-x64",
    "linux-arm64": "glossa-linux-arm64",
    "darwin-x64": "glossa-macos-x64",
    "darwin-arm64": "glossa-macos-arm64",
  };
  const asset = assets[key];
  if (!asset) {
    throw new Error(`Glossa does not publish a standalone update for ${key}.`);
  }
  return asset;
}

export function parseReleaseChecksum(checksumFile: string, asset: string): string {
  for (const line of checksumFile.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1]!.toLowerCase();
  }
  throw new Error("The Glossa checksum file was invalid.");
}

export async function cleanupUpdateBackups(
  distribution: GlossaDistribution,
  options: CleanupUpdateOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (distribution !== "standalone" || platform !== "win32") return;

  const executable = options.executablePath ?? process.execPath;
  const directory = path.dirname(executable);
  const prefix = `${path.basename(executable)}.old-`;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        const ownerPid = backupOwnerPid(entry.name, prefix);
        return ownerPid !== null && !processIsAlive(ownerPid);
      })
      .map(async (entry) => {
        await rm(path.join(directory, entry.name), { force: true }).catch(() => undefined);
      }),
  );
}

function releaseAssetUrl(
  version: string,
  asset: string,
  releaseBaseUrl: string,
): string {
  return `${releaseBaseUrl}/cli-v${encodeURIComponent(version)}/${asset}`;
}

async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch,
  version: string,
): Promise<Uint8Array> {
  const response = await withNetworkErrors(
    async () => await fetchImpl(url, {
      headers: { "User-Agent": `glossa/${version}` },
      signal: AbortSignal.timeout(120_000),
    }),
    "the Glossa release server",
  );
  if (!response.ok) throw new Error(`Glossa could not download ${url} (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  version: string,
): Promise<string> {
  const response = await withNetworkErrors(
    async () => await fetchImpl(url, {
      headers: { "User-Agent": `glossa/${version}` },
      signal: AbortSignal.timeout(30_000),
    }),
    "the Glossa release server",
  );
  if (!response.ok) throw new Error(`Glossa could not download ${url} (HTTP ${response.status}).`);
  return await response.text();
}

export function npmInstallInvocation(
  version: string,
  platform: NodeJS.Platform = process.platform,
  commandShell = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  const normalizedVersion = semver.valid(version);
  if (!normalizedVersion) throw new Error(`Glossa version ${version} is invalid.`);
  const packageSpec = `${PACKAGE_NAME}@${normalizedVersion}`;
  if (platform === "win32") {
    return {
      command: commandShell,
      args: ["/d", "/s", "/c", `npm.cmd install --global ${packageSpec}`],
    };
  }
  return {
    command: "npm",
    args: ["install", "--global", packageSpec],
  };
}

async function runNpmInstall(version: string): Promise<void> {
  const { command, args } = npmInstallInvocation(version);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`npm exited with status ${status ?? "unknown"}.`));
    });
  });
}

async function replaceWindowsExecutable(
  download: string,
  destination: string,
): Promise<void> {
  const backup = `${destination}.old-${process.pid}-${Date.now()}`;
  await rename(destination, backup);
  try {
    await rename(download, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
}

async function installStandaloneUpdate(
  info: UpdateInfo,
  options: InstallUpdateOptions,
): Promise<InstallUpdateResult> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const destination = options.executablePath ?? process.execPath;
  const asset = standaloneAssetName(platform, architecture);
  const releaseBaseUrl =
    options.releaseBaseUrl ??
    process.env.GLOSSA_RELEASE_BASE_URL ??
    DEFAULT_RELEASE_BASE_URL;
  const fetchImpl = options.fetchImpl ?? networkFetch;
  const binaryUrl = releaseAssetUrl(info.availableVersion, asset, releaseBaseUrl);
  const [binary, checksumFile] = await Promise.all([
    fetchBytes(binaryUrl, fetchImpl, info.currentVersion),
    fetchText(`${binaryUrl}.sha256`, fetchImpl, info.currentVersion),
  ]);
  const expected = parseReleaseChecksum(checksumFile, asset);
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new Error("Glossa refused to update because the SHA-256 checksum did not match.");
  }

  const download = path.join(
    path.dirname(destination),
    `${path.basename(destination)}.download-${process.pid}`,
  );
  try {
    await writeFile(download, binary, { mode: 0o755 });
    if (platform === "win32") {
      await replaceWindowsExecutable(download, destination);
    } else {
      await chmod(download, 0o755);
      await rename(download, destination);
    }
    return "installed";
  } catch (error) {
    await rm(download, { force: true });
    throw error;
  }
}

export async function installUpdate(
  info: UpdateInfo,
  distribution: GlossaDistribution,
  options: InstallUpdateOptions = {},
): Promise<InstallUpdateResult> {
  if (!info.updateAvailable) return "installed";
  if (distribution === "npm") {
    await runNpmInstall(info.availableVersion);
    return "installed";
  }
  return await installStandaloneUpdate(info, options);
}
