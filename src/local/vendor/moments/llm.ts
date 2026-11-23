// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/moments/src/llm.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * The model client the generated planner calls (`chatJSON`, `LLMError`), in
 * place of Clipy's server-side OpenRouter client. It talks to any
 * OpenAI-compatible chat completions endpoint: OpenRouter (default), OpenAI,
 * Google Gemini's OpenAI endpoint, Groq, Ollama, LM Studio, or a custom URL.
 *
 * With no provider configured the planner runs on rules only: `chatJSON`
 * answers "no spoken moments", so gestures, clicks and pointer rests are still
 * found and nothing leaves the machine.
 *
 * The provider is scoped to one `planMoments` call through AsyncLocalStorage,
 * not held in module state, so concurrent calls with different providers (or
 * one with a provider and one without) never see each other's settings. The
 * generated planner calls `chatJSON` without a provider argument; this is how
 * `chatJSON` finds the provider of the call it belongs to.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ModelProvider {
  /** Base URL up to and including `/v1` (or the provider's equivalent). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  headers?: Record<string, string>;
}

/** Ready-made base URLs for the providers the CLI and app offer. */
export const PROVIDER_BASE_URLS = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
} as const;

/** Same model the hosted endpoint uses, so results match when the key is OpenRouter. */
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite";

interface ProviderScope {
  provider: ModelProvider | null;
  /** Model answers `chatJSON` returned in this scope. */
  answers: number;
}

const providerScope = new AsyncLocalStorage<ProviderScope>();

/**
 * Run `fn` with `provider` as the model provider for every `chatJSON` call it
 * makes, including calls in promises and timers it starts. null means rules
 * only. Outside such a scope there is no provider.
 */
export async function withModelProvider<T>(provider: ModelProvider | null, fn: () => Promise<T>): Promise<T> {
  return (await runWithModelProvider(provider, fn)).result;
}

/**
 * Like `withModelProvider`, and also says how many model answers the scope
 * used, so a caller can tell "a model picked moments" apart from "a model was
 * configured but never asked" (an empty transcript skips it).
 */
export async function runWithModelProvider<T>(
  provider: ModelProvider | null,
  fn: () => Promise<T>,
): Promise<{ result: T; modelAnswers: number }> {
  const scope: ProviderScope = { provider, answers: 0 };
  const result = await providerScope.run(scope, fn);
  return { result, modelAnswers: scope.answers };
}

/** The provider of the current `withModelProvider` scope, or null. */
export function currentModelProvider(): ModelProvider | null {
  return providerScope.getStore()?.provider ?? null;
}

export class LLMError extends Error {
  readonly transient: boolean;
  readonly upstreamStatus: number | null;
  constructor(opts: { message: string; transient: boolean; upstreamStatus?: number | null }) {
    super(opts.message);
    this.name = "LLMError";
    this.transient = opts.transient;
    this.upstreamStatus = opts.upstreamStatus ?? null;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Ignored: the configured provider's model wins. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Hosted analytics only; ignored here. */
  trace?: unknown;
  signal?: AbortSignal;
  messages: ChatMessage[];
}

function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced ? fenced[1] : text;
}

export async function chatJSON<T = unknown>(opts: ChatOptions): Promise<{ parsed: T; raw: { text: string } }> {
  const scope = providerScope.getStore();
  const provider = scope?.provider ?? null;
  if (!scope || !provider) {
    // Rules only. The planner's schema accepts an empty list.
    return { parsed: { moments: [] } as T, raw: { text: "" } };
  }
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: opts.signal,
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...provider.headers,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    // The body can echo the transcript, so it is not included in the message.
    throw new LLMError({
      message: `Model provider returned HTTP ${res.status}`,
      transient: res.status === 408 || res.status === 429 || res.status >= 500,
      upstreamStatus: res.status,
    });
  }
  const raw = await readCapped(res, MAX_COMPLETION_BYTES);
  type Completion = { choices?: Array<{ message?: { content?: string | null } }> } | null;
  let body: Completion;
  try {
    body = JSON.parse(raw) as Completion;
  } catch {
    body = null;
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) {
    throw new LLMError({ message: MODEL_ERROR.noCompletion, transient: true, upstreamStatus: res.status });
  }
  let parsed: T;
  try {
    parsed = JSON.parse(stripCodeFence(text)) as T;
  } catch {
    throw new LLMError({ message: MODEL_ERROR.unparseable, transient: true, upstreamStatus: res.status });
  }
  scope.answers += 1;
  return { parsed, raw: { text } };
}

/** Largest chat completion read into memory; a moment list is a few KB. */
export const MAX_COMPLETION_BYTES = 2 * 1024 * 1024;

/**
 * Error messages for a model answer that cannot be used. The generated
 * planner's describePlannerError classifies errors by these prefixes, so keep
 * them in step with the replacements in scripts/sync-from-monorepo.mjs.
 */
export const MODEL_ERROR = {
  noCompletion: "Model provider returned no completion",
  unparseable: "Model provider JSON parse failed",
  tooLarge: "Model provider answer was too large",
} as const;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new LLMError({ message: MODEL_ERROR.tooLarge, transient: false, upstreamStatus: res.status });
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
