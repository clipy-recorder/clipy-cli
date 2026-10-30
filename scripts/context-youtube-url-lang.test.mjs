#!/usr/bin/env node
/**
 * Three field bugs, all offline-testable because all are pure decisions:
 *  1. shell-escaped URLs (`watch\?v\=ID`) must normalise, never reach yt-dlp raw
 *  2. caption selection must fall back past en-only, preferring the video's
 *     ORIGINAL language over YouTube's auto-translations of it
 *  3. on an auto-dubbed video, the speech track of the spoken language must
 *     win over a dub and over a translation (RBreC9k03kQ, HTTP 429)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "context");
const { parseYoutubeId, canonicalYoutubeUrl } = await import(pathToFileURL(join(dist, "youtubeUrl.js")));
const { planCaptionAttempts, describeCaptions } = await import(pathToFileURL(join(dist, "ytdlp.js")));

// --- 1. URL normalisation --------------------------------------------------

const ID = "77FB-LS0Bjk";
for (const [input, why] of [
  // The exact string zsh handed the CLI in the owner's run.
  ["https://www.youtube.com/watch\\?v\\=77FB-LS0Bjk", "backslash-escaped ? and ="],
  ["https://www.youtube.com/watch?v=77FB-LS0Bjk", "plain watch URL"],
  ["  https://www.youtube.com/watch?v=77FB-LS0Bjk  ", "surrounding whitespace"],
  ["https://youtu.be/77FB-LS0Bjk", "short link"],
  ["https://youtu.be/77FB-LS0Bjk?t=42", "short link with a start time"],
  ["https://www.youtube.com/shorts/77FB-LS0Bjk", "shorts"],
  ["https://www.youtube.com/live/77FB-LS0Bjk", "live"],
  ["https://www.youtube.com/embed/77FB-LS0Bjk", "embed"],
  ["https://m.youtube.com/watch?v=77FB-LS0Bjk&feature=share", "mobile host + extra params"],
  ["https://music.youtube.com/watch?v=77FB-LS0Bjk", "music host"],
  ["https://www.youtube.com/watch?list=PL123&v=77FB-LS0Bjk", "v= is not the first param"],
  ["https://www.youtube.com/watch\\?v\\=77FB-LS0Bjk\\&list\\=PL123", "fully escaped with a playlist"],
  ["www.youtube.com/watch?v=77FB-LS0Bjk", "no scheme (loose match)"],
]) {
  assert.equal(parseYoutubeId(input), ID, `should extract the id from ${why}: ${input}`);
}

assert.equal(canonicalYoutubeUrl(ID), "https://www.youtube.com/watch?v=77FB-LS0Bjk");

for (const [input, why] of [
  ["https://www.youtube.com/@someChannel", "a channel URL"],
  ["https://www.youtube.com/playlist?list=PL1234567890", "a playlist-only URL"],
  ["https://www.youtube.com/results?search_query=cats", "a search URL"],
  ["https://www.youtube.com/watch?v=tooShort", "an id of the wrong length"],
  ["https://example.com/watch?v=77FB-LS0Bjk", "the right shape on the wrong host"],
]) {
  assert.equal(parseYoutubeId(input), null, `should refuse ${why}: ${input}`);
}

// --- 2. caption language fallback -----------------------------------------

const meta = (over) => ({
  id: ID, title: "t", durationMs: 1000,
  subtitleLangs: [], autoCaptionLangs: [], ...over,
});

// The real 77FB-LS0Bjk shape: no creator subs, a Hindi original, and ~157
// auto-translations including en. en must NOT win over the original.
const hindi = planCaptionAttempts(
  meta({ language: "hi", autoCaptionLangs: ["af", "en", "es", "hi-orig", "zu"] }),
);
assert.equal(hindi[0].track, "hi-orig", "the original-language track must be tried first");
assert.equal(hindi[0].language, "hi", "the -orig suffix is a track name, not a language code");
assert.equal(hindi[0].source, "auto_captions", "the original language is not a translation");
assert.equal(hindi[0].translatedFrom, undefined);
assert.equal(hindi[0].flag, "--write-auto-subs");
assert.equal(hindi[1].track, "en", "en is the second choice, not the first");
assert.equal(hindi[1].source, "auto_captions_translated", "en here is a machine translation of Hindi");
assert.equal(hindi[1].translatedFrom, "hi");
assert.ok(!hindi.some((a) => a.track === "af"), "Afrikaans is not a fallback once Hindi speech has been tried");

// Original identifiable only from the metadata language field (no -orig track).
const viaMetaLang = planCaptionAttempts(meta({ language: "ja", autoCaptionLangs: ["en", "ja", "ko"] }));
assert.equal(viaMetaLang[0].language, "ja");
assert.equal(viaMetaLang[0].source, "auto_captions");

// Only one language available, and it is not English.
const french = planCaptionAttempts(meta({ autoCaptionLangs: ["fr"] }));
assert.equal(french.length, 1, "a single available language should produce a single attempt");
assert.equal(french[0].language, "fr", "fr must be picked rather than failing on en");
assert.equal(french[0].source, "auto_captions", "with no known original, fr is not assumed to be a translation");
assert.equal(describeCaptions(french[0]), "fr, auto-generated; the video's original language is unknown");

// With no speech track at all, whatever is listed is still the last resort.
const noOrig = planCaptionAttempts(meta({ language: "ja", autoCaptionLangs: ["ko", "ja"] }));
assert.deepEqual(noOrig.map((a) => a.track), ["ja", "ko"]);

// Creator captions outrank auto captions, in any language.
const creator = planCaptionAttempts(
  meta({ language: "de", subtitleLangs: ["de"], autoCaptionLangs: ["de-orig", "en"] }),
);
assert.equal(creator[0].source, "creator_captions");
assert.equal(creator[0].language, "de");
assert.equal(creator[0].flag, "--write-subs");
assert.ok(creator.slice(1).every((a) => a.source !== "creator_captions"), "one creator attempt is enough");

// An explicit --language is obeyed exactly — never silently widened.
const explicit = planCaptionAttempts(
  meta({ language: "hi", autoCaptionLangs: ["en", "es", "hi-orig"] }),
  "es",
);
assert.equal(explicit.length, 1, "--language must not fall back to other languages");
assert.equal(explicit[0].language, "es");
assert.equal(explicit[0].source, "auto_captions_translated");
assert.equal(explicit[0].translatedFrom, "hi");

// A regional variant satisfies a base-code request.
const regional = planCaptionAttempts(meta({ subtitleLangs: ["en-US"] }), "en");
assert.equal(regional[0].track, "en-US");

// --- 3. auto-dubbed videos ------------------------------------------------

// The real RBreC9k03kQ track list (yt-dlp 2026.08.19): an English video with
// YouTube auto-dubbing, so there is one -orig track per audio track, ar-orig
// first, after ~150 plain translation tracks. yt-dlp's plain "en" there is
// English translated from the Arabic dub, and was rate-limited; en-orig is
// the English speech.
const dubbedFixture = JSON.parse(readFileSync(join(here, "fixtures", "youtube-dubbed-RBreC9k03kQ.json"), "utf8"));
const dubbedMeta = (over = {}) =>
  meta({ language: dubbedFixture.language, autoCaptionLangs: dubbedFixture.autoCaptionLangs, ...over });

const dubbed = planCaptionAttempts(dubbedMeta());
assert.deepEqual(dubbed.map((a) => a.track), ["en-orig"],
  "the English speech, and no other dub or translation once the original is known");
assert.equal(dubbed[0].source, "auto_captions");
assert.equal(describeCaptions(dubbed[0]), "en, auto-generated — video's original language");

const dubbedExplicit = planCaptionAttempts(dubbedMeta(), "en");
assert.equal(dubbedExplicit.length, 1);
assert.equal(dubbedExplicit[0].track, "en-orig", "--language en must take the English speech, not a translation");
assert.equal(dubbedExplicit[0].source, "auto_captions", "en-orig is not a translation from ar");

// Asking for a dub gets that dub's speech, labelled as a translation.
const dubbedArabic = planCaptionAttempts(dubbedMeta(), "ar");
assert.equal(dubbedArabic[0].track, "ar-orig");
assert.equal(describeCaptions(dubbedArabic[0]), "ar, auto-translated from en");

// A plain track on a dubbed video mixes translations from every audio track,
// so no source language may be named for it.
const dubbedZulu = planCaptionAttempts(dubbedMeta(), "zu");
assert.equal(dubbedZulu[0].track, "zu");
assert.equal(dubbedZulu[0].source, "auto_captions_translated");
assert.equal(dubbedZulu[0].translatedFrom, undefined);
assert.equal(describeCaptions(dubbedZulu[0]), "zu, auto-translated");

// Creator subtitles still win, and the original's comes first.
const dubbedCreator = planCaptionAttempts(dubbedMeta({ subtitleLangs: ["ar", "en"] }));
assert.equal(dubbedCreator[0].track, "en");
assert.equal(dubbedCreator[0].source, "creator_captions");

// Hebrew: yt-dlp reports the retired code iw, and he must find it too.
const dubbedHebrew = planCaptionAttempts(dubbedMeta({ language: "iw" }));
assert.equal(dubbedHebrew[0].track, "iw-orig");
assert.equal(dubbedHebrew[0].source, "auto_captions");
assert.equal(planCaptionAttempts(dubbedMeta({ language: "he" }))[0].track, "iw-orig");
const hebrewCreator = planCaptionAttempts(
  meta({ language: "iw", subtitleLangs: ["iw"], autoCaptionLangs: ["iw-orig", "iw", "en"] }),
  "he",
);
assert.equal(hebrewCreator[0].track, "iw", "--language he must take the creator's iw subtitles");
assert.equal(hebrewCreator[0].source, "creator_captions");

// Several -orig tracks and no metadata language: no original can be claimed,
// and en-orig may well be the original, so it is not called a dub either.
const dubbedUnknown = planCaptionAttempts(dubbedMeta({ language: undefined }));
assert.deepEqual(dubbedUnknown.map((a) => a.track), ["en-orig", "ar-orig"]);
assert.ok(dubbedUnknown.every((a) => a.translatedFrom === undefined && a.originalUnknown === true));
assert.equal(describeCaptions(dubbedUnknown[0]), "en, auto-generated; the video's original language is unknown");

// A metadata language that names none of the dubs is not trusted either.
const dubbedMismatch = planCaptionAttempts(dubbedMeta({ language: "sv" }));
assert.ok(dubbedMismatch.every((a) => a.track.endsWith("-orig") && a.originalUnknown === true));

// --- 4. regions and scripts ------------------------------------------------

// A metadata language with a region still counts as the original.
const usEnglish = planCaptionAttempts(meta({ language: "en-US", autoCaptionLangs: ["en", "es"] }));
assert.equal(usEnglish[0].track, "en");
assert.equal(usEnglish[0].source, "auto_captions", "en-US speech captioned as en is not a translation");
const ptBR = planCaptionAttempts(meta({ language: "pt-BR", autoCaptionLangs: ["pt-BR"] }));
assert.equal(ptBR[0].source, "auto_captions", "the original's own regional tag is the original");

// But two different regions or scripts are a translation apart.
const ptPT = planCaptionAttempts(meta({ language: "pt-BR", autoCaptionLangs: ["pt-PT"] }));
assert.equal(ptPT[0].source, "auto_captions_translated");
assert.equal(ptPT[0].translatedFrom, "pt-BR");

// A requested region or script is honoured, not widened to the base -orig
// track, and is a translation of a bare original.
const hant = planCaptionAttempts(meta({ language: "zh", autoCaptionLangs: ["zh-orig", "zh-Hans", "zh-Hant"] }), "zh-Hant");
assert.equal(hant[0].track, "zh-Hant");
assert.equal(hant[0].source, "auto_captions_translated", "zh-Hant under a zh original is a translation");
assert.equal(hant[0].translatedFrom, "zh");
const ptExplicit = planCaptionAttempts(meta({ language: "pt", autoCaptionLangs: ["ab", "pt-orig", "pt", "pt-PT"] }), "pt-PT");
assert.equal(ptExplicit[0].track, "pt-PT");
assert.equal(ptExplicit[0].source, "auto_captions_translated", "pt-PT under a pt original is a translation");
assert.equal(ptExplicit[0].translatedFrom, "pt");
const enGB = planCaptionAttempts(meta({ language: "en", autoCaptionLangs: ["en-orig", "en", "en-GB"] }), "en-GB");
assert.equal(enGB[0].track, "en-GB");
assert.equal(enGB[0].source, "auto_captions_translated", "en-GB under an en original is a translation");

// Nothing at all to try.
assert.deepEqual(planCaptionAttempts(meta({})), [], "no caption tracks means no attempts");

process.stdout.write("✓ youtube url normalisation (incl. shell escaping) + caption language fallback chain\n");
