// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/config/src/presets.ts by cli/scripts/sync-local.mjs. Do not edit here.
import { DEFAULT_OPENROUTER_MODEL, PROVIDER_BASE_URLS, type ModelProvider } from "../moments/index.js";
import { ConfigError } from "./errors.js";
import { isHttpUrl, type ModelPreset } from "./schema.js";

/** Default model per preset. Ollama, LM Studio and custom have none: the user picks what they run. */
export const DEFAULT_MODELS: Partial<Record<ModelPreset, string>> = {
  openrouter: DEFAULT_OPENROUTER_MODEL, // google/gemini-3.1-flash-lite, as the hosted planner uses
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
};

/** Presets that run on the user's machine and need no key. */
const LOCAL_PRESETS: ReadonlySet<ModelPreset> = new Set(["ollama", "lmstudio"]);

const PRESET_NAMES: Record<ModelPreset, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  gemini: "Gemini",
  groq: "Groq",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "A custom provider",
};

/** OpenAI-compatible transcription endpoints behind the `openai` and `groq` shorthands. */
export const TRANSCRIPTION_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
} as const;

/**
 * The ModelProvider for a preset. `baseUrl` replaces the preset's URL and is
 * required for `custom`. Throws a ConfigError when something the preset needs
 * is missing: a key for the hosted presets, a model name for Ollama, LM Studio
 * and custom.
 */
export function presetProvider(preset: ModelPreset, apiKey?: string, model?: string, baseUrl?: string): ModelProvider {
  const name = PRESET_NAMES[preset];
  if (!name) throw new ConfigError(`Unknown model provider "${String(preset)}". Use one of ${Object.keys(PRESET_NAMES).join(", ")}.`);

  const url = baseUrl?.trim() || (preset === "custom" ? undefined : PROVIDER_BASE_URLS[preset]);
  if (!url) {
    throw new ConfigError(`${name} needs a base URL. Set CLIPY_MODEL_BASE_URL or "model.baseUrl" in the config file.`);
  }
  if (!isHttpUrl(url)) {
    throw new ConfigError(`The model base URL must be an http:// or https:// URL.`);
  }

  const key = apiKey?.trim() || undefined;
  if (!key && preset !== "custom" && !LOCAL_PRESETS.has(preset)) {
    throw new ConfigError(`${name} needs an API key. Set CLIPY_MODEL_API_KEY or "model.apiKey" in the config file.`);
  }

  const chosenModel = model?.trim() || DEFAULT_MODELS[preset];
  if (!chosenModel) {
    throw new ConfigError(
      `${name} needs a model name, for example the name of a model you have pulled or loaded. ` +
        `Set CLIPY_MODEL or "model.model" in the config file.`,
    );
  }

  const provider: ModelProvider = { baseUrl: url, model: chosenModel };
  if (key) provider.apiKey = key;
  if (preset === "openrouter") provider.headers = { "HTTP-Referer": "https://clipy.online", "X-Title": "Clipy" };
  return provider;
}
