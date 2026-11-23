/**
 * Reads a transcript the user already has: WebVTT, SubRip, or JSON (an array
 * of `{startMs, endMs, text}`, a `transcript.json` from a local folder, or a
 * YouTube json3 caption file). Parsing reuses the hosted caption parsers.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { normalizeSegments, parseSrt, parseVtt, parseYoutubeJson3 } from "../context-core/index.js";
import type { TranscriptSegment } from "./ports.js";

function fromJson(value: unknown): TranscriptSegment[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { segments?: unknown }).segments)
      ? (value as { segments: unknown[] }).segments
      : null;
  if (!list) return parseYoutubeJson3(value);
  const out: TranscriptSegment[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const startMs = Number(r.startMs ?? r.start_ms);
    const endMs = Number(r.endMs ?? r.end_ms ?? startMs);
    const text = typeof r.text === "string" ? r.text : "";
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && text.trim()) out.push({ startMs, endMs, text });
  }
  return out;
}

export async function readTranscriptFile(path: string, durationMs?: number): Promise<{ segments: TranscriptSegment[]; label: string }> {
  const text = await readFile(path, "utf8");
  const ext = extname(path).toLowerCase();
  let segments: TranscriptSegment[];
  if (ext === ".vtt") segments = parseVtt(text);
  else if (ext === ".srt") segments = parseSrt(text);
  else if (ext === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${basename(path)} is not valid JSON`);
    }
    segments = fromJson(parsed);
  } else {
    throw new Error(`Unsupported transcript file ${basename(path)}: use .vtt, .srt or .json`);
  }
  if (segments.length === 0) throw new Error(`No transcript segments found in ${basename(path)}`);
  return { segments: normalizeSegments(segments, { durationMs }).segments, label: `caption file ${basename(path)}` };
}
