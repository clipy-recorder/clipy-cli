/**
 * The on-device speech engine (sherpa-onnx-node, about 35 MB of native code)
 * is not a dependency of @clipy/cli, so a plain install stays small. The first
 * time a local take needs on-device transcription, the CLI asks before
 * downloading it, then installs the exact pinned version with npm into a
 * folder Clipy owns (next to the speech models in the user's cache folder),
 * which works for any global npm or pnpm install without write access to it.
 *
 * Accepting up front, for agents and CI: `clipy speech install`, `--yes`, or
 * CLIPY_INSTALL_SPEECH_ENGINE=1. Without one of those and without a terminal
 * to ask in, the take stops before recording with `speech_engine_required`.
 *
 * A copy the CLI can resolve on its own (`npm i -g sherpa-onnx-node` next to
 * a global npm install of the CLI) is used when the Clipy folder has none.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SPEECH_ENGINE_PACKAGE = "sherpa-onnx-node";
/** Exact version: the platform packages it pulls in (sherpa-onnx-darwin-arm64 and so on) follow it. */
export const SPEECH_ENGINE_VERSION = "2.0.1";
/** Installed size across platforms (23 to 40 MB, 34 MB on Apple silicon). */
export const SPEECH_ENGINE_SIZE = "about 35 MB";
export const SPEECH_ENGINE_INSTALL_COMMAND = "clipy speech install";
/** Set to 1 (or true, yes) to accept the download without a prompt. */
export const SPEECH_ENGINE_ACCEPT_ENV = "CLIPY_INSTALL_SPEECH_ENGINE";
/** Overrides the folder the engine is installed into. */
export const SPEECH_ENGINE_DIR_ENV = "CLIPY_SPEECH_ENGINE_DIR";

export interface SpeechEngineStatus {
  installed: boolean;
  /** The sherpa-onnx-node entry file to load, when installed. */
  entry: string | null;
  /** "clipy": the Clipy-owned folder; "alongside": a copy the CLI resolves itself. */
  source: "clipy" | "alongside" | null;
  /** Where `install` puts it. */
  dir: string;
  version: string;
}

export interface SpeechEngine {
  status(): SpeechEngineStatus;
  install(options?: { signal?: AbortSignal }): Promise<SpeechEngineStatus>;
}

/** `<cache>/clipy-local/speech-engine`, beside the speech models. */
export function speechEngineRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const override = env[SPEECH_ENGINE_DIR_ENV]?.trim();
  if (override) return override;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "clipy-local", "speech-engine");
  if (platform === "darwin") return join(home, "Library", "Caches", "clipy-local", "speech-engine");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "clipy-local", "speech-engine");
}

export function speechEngineDir(root = speechEngineRoot()): string {
  return join(root, `${SPEECH_ENGINE_PACKAGE}-${SPEECH_ENGINE_VERSION}`);
}

/** The entry file of an install in `dir`, or null. Resolution stays inside `dir`. */
function entryIn(dir: string): string | null {
  if (!existsSync(join(dir, "node_modules", SPEECH_ENGINE_PACKAGE, "package.json"))) return null;
  try {
    return createRequire(join(dir, "package.json")).resolve(SPEECH_ENGINE_PACKAGE);
  } catch {
    return null;
  }
}

function entryAlongside(): string | null {
  try {
    return createRequire(import.meta.url).resolve(SPEECH_ENGINE_PACKAGE);
  } catch {
    return null;
  }
}

export function speechEngineStatus(root = speechEngineRoot(), alongside: () => string | null = entryAlongside): SpeechEngineStatus {
  const dir = speechEngineDir(root);
  const base = { dir, version: SPEECH_ENGINE_VERSION };
  const own = entryIn(dir);
  if (own) return { installed: true, entry: own, source: "clipy", ...base };
  const other = alongside();
  if (other) return { installed: true, entry: other, source: "alongside", ...base };
  return { installed: false, entry: null, source: null, ...base };
}

export class SpeechEngineInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechEngineInstallError";
  }
}

interface Command {
  cmd: string;
  args: string[];
  shell: boolean;
}

/**
 * npm, run with this same Node: the npm that ships next to it, CLIPY_NPM
 * (an executable or an npm-cli.js), or `npm` on the PATH.
 */
export function npmCommand(env: NodeJS.ProcessEnv = process.env): Command {
  const override = env.CLIPY_NPM?.trim();
  if (override) {
    return /\.[cm]?js$/.test(override) ? { cmd: process.execPath, args: [override], shell: false } : { cmd: override, args: [], shell: false };
  }
  let nodeDir = dirname(process.execPath);
  try {
    nodeDir = dirname(realpathSync(process.execPath));
  } catch {
    // keep the unresolved folder
  }
  for (const cli of [join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(cli)) return { cmd: process.execPath, args: [cli], shell: false };
  }
  // npm.cmd only starts through a shell on Windows.
  return process.platform === "win32" ? { cmd: "npm.cmd", args: [], shell: true } : { cmd: "npm", args: [], shell: false };
}

function run(command: Command, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const all = [...command.args, ...args].map((a) => (command.shell ? `"${a}"` : a));
    const child = spawn(command.cmd, all, { cwd, env, shell: command.shell, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      if (stderr.length < 64_000) stderr += String(d);
    });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolveRun({ code, stderr });
    });
  });
}

/** npm settings from a parent `npm exec`/`pnpm dlx` that would send the install elsewhere. */
function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^npm_config_(global|location|prefix)$/i.test(key)) delete out[key];
  }
  return out;
}

function firstLines(text: string, n = 3): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(" ");
}

/**
 * Installs the pinned engine into a staging folder, checks that it loads on
 * this machine, then renames it into place, so the folder is complete or absent.
 */
export async function installSpeechEngine(
  options: { root?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; alongside?: () => string | null } = {},
): Promise<SpeechEngineStatus> {
  const env = options.env ?? process.env;
  const root = options.root ?? speechEngineRoot(env);
  const finalDir = speechEngineDir(root);
  if (entryIn(finalDir)) return speechEngineStatus(root, options.alongside);
  await mkdir(root, { recursive: true });
  const staging = join(root, `.install-${process.pid}-${Date.now().toString(36)}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify({ name: "clipy-speech-engine", private: true, description: "Installed by the Clipy CLI for on-device transcription." }, null, 2)}\n`,
    );
    const npm = npmCommand(env);
    const spec = `${SPEECH_ENGINE_PACKAGE}@${SPEECH_ENGINE_VERSION}`;
    let result: { code: number | null; stderr: string };
    try {
      result = await run(
        npm,
        ["install", spec, "--save-exact", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error", "--prefix", staging],
        staging,
        installEnv(env),
        options.signal,
      );
    } catch (error) {
      throw new SpeechEngineInstallError(
        `could not run npm to download the speech engine (${(error as Error).message}). Install Node.js with npm, or install it yourself with npm i -g ${spec}.`,
      );
    }
    if (options.signal?.aborted) throw new SpeechEngineInstallError("the speech engine download was cancelled");
    if (result.code !== 0) {
      throw new SpeechEngineInstallError(`npm could not download ${spec}: ${firstLines(result.stderr) || `exit code ${result.code}`}`);
    }
    const entry = entryIn(staging);
    if (!entry) throw new SpeechEngineInstallError(`npm finished but ${SPEECH_ENGINE_PACKAGE} is missing from ${staging}`);
    // Load it in a child: the native part (sherpa-onnx-<platform>-<arch>) must
    // be there and start on this machine, and a crash must not take the CLI down.
    const check = await run({ cmd: process.execPath, args: [], shell: false }, ["-e", "require(process.argv[1])", entry], staging, env, options.signal);
    if (check.code !== 0) {
      throw new SpeechEngineInstallError(
        `the speech engine was downloaded but does not load on this machine (${process.platform}-${process.arch}): ${firstLines(check.stderr, 1) || `exit code ${check.code}`}`,
      );
    }
    // Another CLI may have finished the same install meanwhile: keep its copy.
    if (!entryIn(finalDir)) {
      await rm(finalDir, { recursive: true, force: true });
      await rename(staging, finalDir);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  await removeOtherVersions(root);
  return speechEngineStatus(root, options.alongside);
}

/** Older pinned versions left by an earlier CLI. Best-effort. */
async function removeOtherVersions(root: string): Promise<void> {
  const keep = `${SPEECH_ENGINE_PACKAGE}-${SPEECH_ENGINE_VERSION}`;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${SPEECH_ENGINE_PACKAGE}-`) && name !== keep) await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

export function realSpeechEngine(env: NodeJS.ProcessEnv = process.env): SpeechEngine {
  return {
    status: () => speechEngineStatus(speechEngineRoot(env)),
    install: (options = {}) => installSpeechEngine({ ...options, env }),
  };
}

// ---- Consent ----------------------------------------------------------------

/** The take stops because the engine is missing and nobody agreed to download it. */
export class SpeechEngineRequiredError extends Error {
  readonly code = "speech_engine_required";
  readonly command = SPEECH_ENGINE_INSTALL_COMMAND;
  readonly declined: boolean;
  constructor(declined: boolean) {
    super(
      declined
        ? `Stopped: on-device transcription needs the speech engine, and it was not downloaded. Run ${SPEECH_ENGINE_INSTALL_COMMAND} when you want it, or choose another transcription option with clipy local setup --transcribe.`
        : `On-device transcription needs the speech engine (${SPEECH_ENGINE_PACKAGE} ${SPEECH_ENGINE_VERSION}, ${SPEECH_ENGINE_SIZE}), which is not installed. ` +
            `Run ${SPEECH_ENGINE_INSTALL_COMMAND} (or add --yes, or set ${SPEECH_ENGINE_ACCEPT_ENV}=1) to download it, or choose another transcription option with clipy local setup --transcribe.`,
    );
    this.name = "SpeechEngineRequiredError";
    this.declined = declined;
  }
}

export function acceptedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|y)$/i.test(env[SPEECH_ENGINE_ACCEPT_ENV]?.trim() ?? "");
}

export function speechEnginePrompt(dir: string): string {
  return (
    `On-device transcription needs the speech engine: ${SPEECH_ENGINE_PACKAGE} ${SPEECH_ENGINE_VERSION} from npm, ${SPEECH_ENGINE_SIZE}. ` +
    `It is downloaded once, into ${dir}. Download it now? [Y/n] `
  );
}

export interface ConsentIo {
  stderr(text: string): void;
  /** Asks on the terminal; absent when there is no terminal to ask in. */
  confirm?(question: string): Promise<boolean>;
}

/**
 * Makes sure the engine is there before a take that needs it: present, or
 * accepted (`assumeYes`, the env var, or a yes at the prompt) and installed.
 * Otherwise throws SpeechEngineRequiredError.
 */
export async function ensureSpeechEngine(
  speech: SpeechEngine,
  io: ConsentIo,
  options: { json: boolean; assumeYes?: boolean; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<"present" | "installed"> {
  const status = speech.status();
  if (status.installed) return "present";
  let accepted = options.assumeYes === true || acceptedByEnv(options.env);
  if (!accepted) {
    if (options.json || !io.confirm) throw new SpeechEngineRequiredError(false);
    accepted = await io.confirm(speechEnginePrompt(status.dir));
    if (!accepted) throw new SpeechEngineRequiredError(true);
  }
  if (!options.json) io.stderr(`Downloading the speech engine (${SPEECH_ENGINE_PACKAGE} ${SPEECH_ENGINE_VERSION}, ${SPEECH_ENGINE_SIZE})...\n`);
  const installed = await speech.install({ signal: options.signal });
  if (!options.json) io.stderr(`Speech engine ready: ${installed.dir}\n`);
  return "installed";
}
