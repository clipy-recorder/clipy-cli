/**
 * The real implementations behind `Deps` (ports.ts), from the vendored local
 * edition packages. Tests inject fakes instead.
 *
 * Loaded lazily by the CLI (`await import("./local/deps.js")`), so commands
 * that never run local mode do not load the capture, transcription or config
 * code at all.
 */
import * as capture from "./vendor/capture/index.js";
import * as config from "./vendor/config/index.js";
import * as transcribe from "./vendor/transcribe/index.js";
import type { Deps } from "./ports.js";
import { speechEngineStatus } from "./speechEngine.js";

export function realDeps(): Deps {
  return {
    // The engine lives in a folder of its own (downloaded on first use), so
    // the vendored package is told where; it cannot resolve it by name.
    transcribe: (input, cfg, options) =>
      transcribe.transcribe(input, cfg, { ...options, speechEngine: options?.speechEngine ?? speechEngineStatus().entry ?? undefined }),
    downloadModel: (model, options) => transcribe.downloadModel(model, options),
    modelStatus: (model) => transcribe.modelStatus(model),
    modelInfo: (model) => {
      // `license` and `attribution` are optional in the model table; older
      // vendored copies lack them and `clipy models` falls back to its own.
      const spec = transcribe.LOCAL_MODELS[model] as { label: string; sizeBytes: number; license?: unknown; attribution?: unknown };
      return {
        label: spec.label,
        sizeBytes: spec.sizeBytes,
        ...(typeof spec.license === "string" ? { license: spec.license } : {}),
        ...(typeof spec.attribution === "string" ? { attribution: spec.attribution } : {}),
      };
    },
    checkCapture: () => capture.checkCapture(),
    listSources: () => capture.listSources(),
    startCapture: (options) => capture.startCapture(options),
    startVirtualDisplay: (options) => capture.startVirtualDisplay(options),
    stopAllChildren: () => capture.stopAllChildren(),
    loadConfig: () => config.loadConfig(),
    // saveConfig validates the shape with zod at runtime, so this cast is checked.
    saveConfig: (patch) => config.saveConfig(patch as config.StoredConfig),
    presetProvider: (preset, apiKey, model, baseUrl) =>
      config.presetProvider(preset as config.ModelPreset, apiKey, model, baseUrl),
    configPath: () => config.configPath(),
  };
}
