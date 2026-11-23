// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/transcribe/src/providers/http.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * Shared HTTP plumbing for the hosted providers. Errors name the provider and
 * the HTTP status only: response bodies can echo transcript text, and request
 * details carry the user's key, so neither is ever put in a message or log.
 */

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  constructor(provider: string, status?: number, detail?: string) {
    let msg: string;
    if (status === undefined) {
      msg = `${provider} transcription failed: ${detail ?? "the provider could not be reached"}`;
    } else {
      msg = `${provider} transcription failed (HTTP ${status})`;
      if (status === 401 || status === 403) msg += ": check the API key";
      else if (status === 413) msg += ": the audio is too large for this provider";
      else if (status === 429) msg += ": rate limited, try again later";
      else if (detail) msg += `: ${detail}`;
    }
    super(msg);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Largest provider answer read into memory. A transcript of hours of speech is a few MB. */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * A transfer is abandoned when nothing moves for this long: no upload slice
 * sent, no answer chunk read.
 */
export const PROVIDER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a provider may think after the whole upload has gone before its
 * answer starts. Long, because a synchronous provider can take many minutes
 * over a recording of a few hours.
 */
export const PROVIDER_ANSWER_WAIT_MS = 20 * 60 * 1000;

export interface RequestTiming {
  idleMs?: number;
  answerWaitMs?: number;
}

/** Upload slice: progress is counted per slice handed to the connection. */
const UPLOAD_SLICE = 64 * 1024;

interface Sent {
  res: Response;
  /** The ProviderError for a timeout, or null when the clock did not run out. */
  timeoutError: () => ProviderError | null;
  /** Restart the idle clock; the caller calls it per answer chunk. */
  bump: () => void;
  done: () => void;
}

/** The request body as bytes plus the content type its encoding needs (FormData only). */
async function bodyBytes(url: string, init: RequestInit): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
  const body = init.body;
  if (body === undefined || body === null) return null;
  if (body instanceof Uint8Array) return { bytes: body, contentType: null };
  if (typeof body === "string") return { bytes: Buffer.from(body, "utf8"), contentType: "text/plain;charset=UTF-8" };
  const r = new Request(url, { method: init.method ?? "POST", body });
  return { bytes: new Uint8Array(await r.arrayBuffer()), contentType: r.headers.get("content-type") };
}

async function send(provider: string, url: string, init: RequestInit, signal: AbortSignal | undefined, timing: RequestTiming): Promise<Sent> {
  const idleMs = timing.idleMs ?? PROVIDER_IDLE_TIMEOUT_MS;
  const answerWaitMs = timing.answerWaitMs ?? PROVIDER_ANSWER_WAIT_MS;
  const clock = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  const arm = (ms: number, answerWait: boolean) => {
    clearTimeout(timer);
    waiting = answerWait;
    timer = setTimeout(() => clock.abort(), ms);
  };
  const bump = () => arm(idleMs, false);
  const done = () => clearTimeout(timer);
  const combined = signal ? AbortSignal.any([signal, clock.signal]) : clock.signal;
  const timeoutError = () => {
    if (!clock.signal.aborted || signal?.aborted) return null;
    return new ProviderError(
      provider,
      undefined,
      waiting ? `no answer ${Math.round(answerWaitMs / 60_000)} min after the upload, gave up` : `no progress for ${Math.round(idleMs / 1000)} s, gave up`,
    );
  };
  bump();

  let res: Response;
  try {
    const body = await bodyBytes(url, init);
    let finalInit: RequestInit & { duplex?: "half" } = { ...init, redirect: "error", signal: combined };
    if (body) {
      // Streamed in slices so a slow upload that is still moving is not cut
      // off; once it has all gone, the provider gets the longer answer wait.
      const headers = new Headers(init.headers);
      if (body.contentType && !headers.has("content-type")) headers.set("content-type", body.contentType);
      headers.set("content-length", String(body.bytes.byteLength));
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= body.bytes.byteLength) {
            arm(answerWaitMs, true);
            return controller.close();
          }
          bump();
          controller.enqueue(body.bytes.subarray(offset, offset + UPLOAD_SLICE));
          offset += UPLOAD_SLICE;
        },
      });
      finalInit = { ...finalInit, headers, body: stream, duplex: "half" };
    }
    res = await fetch(url, finalInit);
    bump();
  } catch (err) {
    done();
    const timedOut = timeoutError();
    if (timedOut) throw timedOut;
    if ((err as Error).name === "AbortError" || signal?.aborted) throw err;
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new ProviderError(provider, undefined, code ? `network error (${code})` : "the provider could not be reached");
  }
  if (!res.ok) {
    done();
    // Drain without reading the body into any message.
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(provider, res.status);
  }
  return { res, timeoutError, bump, done };
}

/**
 * fetch that turns network failures and non-2xx answers into a ProviderError.
 * Redirects are refused: requests carry the user's key in headers
 * (xi-api-key, x-goog-api-key, Authorization), and a redirect must not take
 * it to another host. Times out per `timing` until the answer starts; the
 * caller owns reading the body.
 */
export async function request(provider: string, url: string, init: RequestInit, signal?: AbortSignal, timing: RequestTiming = {}): Promise<Response> {
  const sent = await send(provider, url, init, signal, timing);
  sent.done();
  return sent.res;
}

/**
 * Read a response body as UTF-8, failing once it passes `maxBytes` (checked
 * against Content-Length first, then while streaming) so a broken or hostile
 * endpoint cannot fill memory. `onTooLarge` builds the error to throw.
 */
export async function readCappedText(res: Response, maxBytes: number, onTooLarge: () => Error, onChunk?: () => void): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw onTooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw onTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function requestJson<T = unknown>(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  maxBytes: number = MAX_RESPONSE_BYTES,
  timing: RequestTiming = {},
): Promise<T> {
  const { res, timeoutError, bump, done } = await send(provider, url, init, signal, timing);
  let text: string;
  try {
    text = await readCappedText(
      res,
      maxBytes,
      () => new ProviderError(provider, undefined, `the answer was larger than ${Math.round(maxBytes / (1024 * 1024))} MB`),
      bump,
    );
  } catch (err) {
    const timedOut = timeoutError();
    if (timedOut) throw timedOut;
    if (err instanceof ProviderError || (err as Error).name === "AbortError" || signal?.aborted) throw err;
    throw new ProviderError(provider, undefined, "the answer was cut off");
  } finally {
    done();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, res.status, "the answer was not valid JSON");
  }
}

function cancelled(): Error {
  const err = new Error("Transcription was cancelled");
  err.name = "AbortError";
  return err;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelled());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
