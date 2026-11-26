export const SETUP_TARGETS = ["claude", "codex", "cursor", "windsurf", "opencode"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export function isSetupTarget(value: string | undefined): value is SetupTarget {
  return !!value && (SETUP_TARGETS as readonly string[]).includes(value);
}

export const MCP_SERVER_NAME = "clipy";
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", "@clipy/mcp@latest"] as const;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export interface SetupEnv {
  home: string;
  env: NodeJS.ProcessEnv;
  run: (command: string, args: readonly string[]) => Promise<CommandResult>;
}

export type McpMethod = "agent-cli" | "config-file" | "manual";

/** Claude Code plugins `clipy setup claude` installs from the Clipy marketplace. */
export const CLIPY_MARKETPLACE_SOURCE = "clipy-recorder/clipy";
export const CLIPY_MARKETPLACE_NAME = "clipy";
export const CLIPY_PLUGINS = ["record", "watch", "clipy-record"] as const;

/** How the setup summary names each plugin: a slash command, or the button. */
export const CLIPY_PLUGIN_LABELS: Record<(typeof CLIPY_PLUGINS)[number], string> = {
  record: "/record",
  watch: "/watch",
  "clipy-record": "the Record button",
};

export interface PluginInstall {
  name: string;
  installed: boolean;
  alreadyInstalled: boolean;
  error?: string;
}

export interface PluginSetup {
  ok: boolean;
  marketplace: { added: boolean; error?: string };
  plugins: PluginInstall[];
  /** What to run by hand when something did not install. */
  command?: string;
}

export interface McpRegistration {
  method: McpMethod;
  path: string | null;
  changed: boolean;
  alreadyPresent: boolean;
  command?: string;
  snippet?: string;
  reason?: string;
}
