/**
 * PronunciationService
 * -----------------------------------------------------------------------
 * Single source of truth for text-to-speech in the app.
 *
 * IMPORTANT LESSON (why this looks the way it does):
 * The Web Speech API (window.speechSynthesis) is a *browser* feature.
 * Capacitor apps run inside the Android system WebView, and on a large
 * number of Android devices/OEMs that WebView does NOT implement
 * speechSynthesis at all - not a permissions issue, not a gesture issue,
 * the API object simply doesn't exist. That's why it reported
 * "unsupported-device" even though the code itself was fine.
 *
 * The fix: on a native platform, call Android's own native
 * text-to-speech engine through the Capacitor plugin
 * @capacitor-community/text-to-speech. That talks to the OS directly,
 * bypassing the WebView entirely, so it works regardless of WebView
 * capabilities. In the browser (the Claude preview / `npm run dev`),
 * there's no native bridge, so it falls back to window.speechSynthesis,
 * which real desktop/mobile browsers DO support.
 */
import { Capacitor } from "@capacitor/core";

let cachedVoices = [];
let primed = false;
let lastError = null;
let eventLog = []; // capped ring buffer of recent speak attempts, for diagnostics

function logEvent(event) {
  eventLog = [...eventLog.slice(-19), { time: new Date().toISOString(), event }];
}

/** Call once, as early as possible (app startup). Safe to call multiple times. */
export function primeVoices() {
  if (Capacitor.isNativePlatform()) return; // native TTS doesn't need this
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const load = () => { cachedVoices = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.onvoiceschanged = load;
  primed = true;
}

function pickWebVoice(preferredAccent) {
  const voices = cachedVoices.length ? cachedVoices : (window.speechSynthesis?.getVoices() ?? []);
  const byLang = (lang) => voices.find((v) => v.lang === lang);
  const byPrefix = (prefix) => voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
  if (preferredAccent === "gb") return byLang("en-GB") || byLang("en-US") || byPrefix("en") || null;
  return byLang("en-US") || byLang("en-GB") || byPrefix("en") || null;
}

/**
 * Speak a word/phrase immediately.
 * Returns a Promise (native path is async - that's fine, native plugin
 * calls aren't subject to the browser's "must be synchronous in a click
 * handler" autoplay rule the way window.speechSynthesis is).
 *
 * @param {string} text
 * @param {{ accent?: 'us' | 'gb', rate?: number }} options
 * @returns {Promise<{ ok: boolean, reason?: 'unsupported-device' | 'no-english-voice' | 'error' }>}
 */
export async function speak(text, options = {}) {
  const { accent = "us", rate = 0.9 } = options;

  // ---- Native Android/iOS: use the OS text-to-speech engine ----
  if (Capacitor.isNativePlatform()) {
    try {
      const { TextToSpeech } = await import("@capacitor-community/text-to-speech");
      await TextToSpeech.speak({
        text,
        lang: accent === "gb" ? "en-GB" : "en-US",
        rate,
        category: "ambient",
      });
      logEvent(`native speak ok: "${text}"`);
      return { ok: true };
    } catch (e) {
      console.error("Native TTS failed", e);
      lastError = String(e?.message || e);
      logEvent(`native speak FAILED: "${text}" - ${lastError}`);
      return { ok: false, reason: "error" };
    }
  }

  // ---- Browser (preview / npm run dev): Web Speech API ----
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    lastError = "speechSynthesis not available in this environment";
    logEvent(`unsupported-device: "${text}"`);
    return { ok: false, reason: "unsupported-device" };
  }
  if (!primed) primeVoices();
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickWebVoice(accent);
    if (!voice) {
      utter.lang = accent === "gb" ? "en-GB" : "en-US";
      window.speechSynthesis.speak(utter);
      logEvent(`web speak ok (no matching voice, used lang fallback): "${text}"`);
      return { ok: true, reason: cachedVoices.length ? "no-english-voice" : undefined };
    }
    utter.voice = voice;
    utter.lang = voice.lang;
    utter.rate = rate;
    window.speechSynthesis.speak(utter);
    logEvent(`web speak ok (voice: ${voice.name}): "${text}"`);
    return { ok: true };
  } catch (e) {
    console.error("PronunciationService.speak failed", e);
    lastError = String(e?.message || e);
    logEvent(`web speak FAILED: "${text}" - ${lastError}`);
    return { ok: false, reason: "error" };
  }
}

export function isSupported() {
  if (Capacitor.isNativePlatform()) return true;
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Snapshot of everything useful for diagnosing "pronunciation isn't
 * working" reports - platform, voice availability, and a short recent
 * event log - without needing a real device to inspect it live. */
export function getDiagnostics() {
  const native = Capacitor.isNativePlatform();
  const webSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const voices = cachedVoices.length
    ? cachedVoices
    : (typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis.getVoices() : []);
  return {
    platform: native ? Capacitor.getPlatform() : "web",
    isNative: native,
    speechSupported: native ? true : webSupported,
    voiceCount: voices.length,
    voices: voices.map((v) => ({ name: v.name, lang: v.lang, default: !!v.default })),
    lastError,
    eventLog,
  };
}
