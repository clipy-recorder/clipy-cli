/**
 * The contracts this CLI needs from its sibling packages, written out here so
 * the CLI compiles and tests on its own. `deps.ts` supplies the real
 * implementations; tests pass fakes.
 *
 * - @clipy/transcribe: speech to timestamped segments (local model or the
 *   user's own provider key).
 * - @clipy/capture: screen capture with an interaction sidecar.
 * - @clipy/local-config: the user's settings file.
 */
import type { ModelProvider } from "./vendor/moments/index.js";

export type { ModelProvider };

// ---- @clipy/transcribe ----------------------------------------------------

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export type LocalModel = "english-fast" | "multilingual";

export type TranscriptionConfig =
  | { kind: "none" }
  | { kind: "local"; model: LocalModel }
  | { kind: "openai-compatible"; baseUrl: string; apiKey: string; model: string }
  | { kind: "deepgram" | "assemblyai" | "elevenlabs" | "gemini"; apiKey: string; model?: string };

export interface TranscribeResult {
  segments: TranscriptSegment[];
  engine: string;
  language?: string;
  gaps: Array<{ startMs: number; endMs: number; reason: string }>;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  modelDir?: string;
  onProgress?: (p: { stage: "extract" | "download" | "transcribe"; fraction: number }) => void;
  /** The sherpa-onnx-node entry file for on-device transcription (see speechEngine.ts). */
  speechEngine?: string;
}

// ---- @clipy/capture -------------------------------------------------------

export interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width?: number;
  height?: number;
}

export interface InteractionEvent {
  kind: "move" | "down" | "up" | "scroll" | "key_down" | "key_up";
  time_ms: number;
  x?: number;
  y?: number;
  button?: number;
}

export interface CaptureGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  output_width?: number;
  output_height?: number;
}

export interface CaptureResult {
  path: string;
  durationMs: number;
  interactions: InteractionEvent[];
  geometry: CaptureGeometry | null;
  warnings: string[];
}

export interface CaptureSession {
  readonly startedAt: number;
  stop(): Promise<CaptureResult>;
  abort(): Promise<void>;
}

export interface StartCaptureOptions {
  source?: string;
  outPath: string;
  fps?: number;
  maxSeconds?: number;
  microphone?: boolean | string;
  xDisplay?: string;
}

export interface CaptureCheck {
  ok: boolean;
  ffmpeg: string | null;
  problems: string[];
  hints: string[];
}

export interface VirtualDisplay {
  display: string;
  /** The Xauthority file apps on this display need, or null when it has no access control. */
  xauthority?: string | null;
  /** Things to tell the user (no access control, apps need XAUTHORITY). */
  warnings?: string[];
  stop(): Promise<void>;
}

// ---- @clipy/local-config --------------------------------------------------

/** Resolved settings: the saved file with CLIPY_MODEL_* and CLIPY_TRANSCRIBE* env vars on top. */
export interface LocalConfig {
  model: ModelProvider | null;
  modelPreset: string | null;
  transcription: TranscriptionConfig;
  telemetry: false;
}

/** The model provider as saved in the config file (keys and defaults resolve on load). */
export interface StoredModel {
  preset: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Transcription as saved in the config file; `openai` and `groq` are shorthands for their endpoints. */
export type StoredTranscription =
  | { kind: "none" }
  | { kind: "local"; model?: LocalModel }
  | { kind: "openai" | "groq"; apiKey: string; model?: string }
  | { kind: "openai-compatible"; baseUrl: string; apiKey?: string; model: string }
  | { kind: "deepgram" | "assemblyai" | "elevenlabs" | "gemini"; apiKey: string; model?: string };

/** What `saveConfig` merges into the file. */
export interface StoredConfigPatch {
  model?: StoredModel | null;
  transcription?: StoredTranscription;
}

// ---- What the CLI is given ------------------------------------------------

export interface Deps {
  transcribe(inputPath: string, config: TranscriptionConfig, options?: TranscribeOptions): Promise<TranscribeResult>;
  /** `signal` aborts the download; the partial files are removed. */
  downloadModel(model: LocalModel, options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<string>;
  modelStatus(model: LocalModel): { installed: boolean; dir: string };
  /** What `clipy models list` shows next to each model. Licence fields come from the model table when it has them. */
  modelInfo(model: LocalModel): { label: string; sizeBytes: number; license?: string; attribution?: string };

  checkCapture(): Promise<CaptureCheck>;
  listSources(): Promise<CaptureSource[]>;
  startCapture(options: StartCaptureOptions): Promise<CaptureSession>;
  startVirtualDisplay(options?: { width?: number; height?: number }): Promise<VirtualDisplay>;
  /**
   * Stops every ffmpeg, pointer helper and Xvfb the capture package started.
   * Its own exit hook does this too, but a process killed by a signal skips
   * exit hooks, so signal paths call it. Optional for fakes.
   */
  stopAllChildren?(): void;

  loadConfig(): LocalConfig;
  /** Merges the patch into the config file (stored shape, not the resolved one). */
  saveConfig(patch: StoredConfigPatch): void;
  /** Resolves a preset; throws when something it needs (a key, a model, a URL) is missing. */
  presetProvider(preset: string, apiKey?: string, model?: string, baseUrl?: string): ModelProvider;
  configPath(): string;
}
