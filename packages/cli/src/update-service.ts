import { spawn } from "node:child_process";
import semver from "semver";
import type { UpdateChannel } from "./update-state.js";

const PACKAGE_NAME = "@ariobarin/glossa";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/@ariobarin%2Fglossa";

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

  const response = await (options.fetchImpl ?? fetch)(
    options.registryUrl ?? process.env.GLOSSA_NPM_REGISTRY_URL ?? DEFAULT_REGISTRY_URL,
    {
      headers: { Accept: "application/json", "User-Agent": `glossa/${currentVersion}` },
      ...(options.signal ? { signal: options.signal } : {}),
    },
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

export async function installUpdate(info: UpdateInfo): Promise<void> {
  if (info.updateAvailable) await runNpmInstall(info.availableVersion);
}
