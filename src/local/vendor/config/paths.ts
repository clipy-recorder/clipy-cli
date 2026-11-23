// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/config/src/paths.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Read an env var, treating an empty or blank value as unset. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Where the settings file lives:
 * - `CLIPY_LOCAL_CONFIG`, when set, wins everywhere.
 * - macOS: `~/Library/Application Support/clipy-local/config.json`.
 * - Windows: `%APPDATA%\clipy-local\config.json`.
 * - Linux and others: `$XDG_CONFIG_HOME/clipy-local/config.json`, or
 *   `~/.config/clipy-local/config.json` when XDG_CONFIG_HOME is unset or not
 *   an absolute path (the XDG spec says to ignore relative values).
 */
export function configPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = envValue(env, "CLIPY_LOCAL_CONFIG");
  if (override) return override;

  if (platform === "win32") {
    const appData = envValue(env, "APPDATA");
    if (appData) return win32.join(appData, "clipy-local", "config.json");
    const home = envValue(env, "USERPROFILE") ?? homedir();
    return win32.join(home, "AppData", "Roaming", "clipy-local", "config.json");
  }

  const home = envValue(env, "HOME") ?? homedir();
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "clipy-local", "config.json");
  }
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  const base = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".config");
  return posix.join(base, "clipy-local", "config.json");
}
