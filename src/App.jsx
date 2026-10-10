/**
 * حصيلتي (Hasila) - Arabic English vocabulary & spaced-repetition app.
 * Original work created and owned by Angelos Onsy.
 * This notice is part of the source and should not be removed.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import Papa from "papaparse";
import "@fontsource/cairo/arabic-400.css";
import "@fontsource/cairo/arabic-600.css";
import "@fontsource/cairo/arabic-700.css";
import "@fontsource/cairo/latin-400.css";
import "@fontsource/cairo/latin-700.css";
import "@fontsource/space-mono/latin-400.css";
import "@fontsource/space-mono/latin-700.css";
import {
  Plus, BookOpen, Layers, LayoutGrid, Search, Volume2, Upload, Download,
  Trash2, Check, RotateCcw, ChevronDown, ChevronLeft, Flame, Settings as SettingsIcon,
  MessageSquare, Eye, EyeOff, GraduationCap, Star, AlertTriangle, Link2, Info, Sprout, Zap, Headphones, Lock,
} from "lucide-react";
import { speak, primeVoices } from "./services/PronunciationService.js";
import {
  applySM2, applyPerformanceTracking,
  nextBucket, BUCKET_LABEL, BUCKET_COLOR,
} from "./services/SM2Engine.js";
import { buildSession, buildSituationSession, buildQuickSession, buildQuickSituationSession, levelIndex, bucketOf, hashToUnit, shuffle } from "./services/SchedulerService.js";
import { computeStatistics, findLeeches, computeActivityHeatmap, LEECH_THRESHOLD } from "./services/StatisticsService.js";
import { DEFAULT_SETTINGS, scheduleReminder, requestNotificationPermission, clampCaps, capMax } from "./services/SettingsService.js";
import { applyDailyStreakUpdate, initialStreak, FREEZE_CAP, MILESTONES } from "./services/StreakService.js";
import { getRandomMotivation } from "./services/MotivationService.js";
import { loadData, saveData, emptyWordExtras } from "./services/StorageService.js";
import { downloadBackup, parseBackup } from "./services/BackupService.js";
import { parseWordsCSV, analyzeWordRows, exportWordsCSV, parseSituationsCSV, analyzeSituationRows, exportSituationsCSV, downloadCSV } from "./services/CSVService.js";
import { getDiagnostics } from "./services/PronunciationService.js";
import { pickLevelCheckWords, evaluateLevelCheck } from "./services/LevelCheckService.js";
import { showRewardedForStreak, showBannerAd, hideBannerAd } from "./services/AdMobService.js";
import { App as CapacitorApp } from "@capacitor/app";
import { isLocked, markSessionComplete, unlockPatch } from "./services/DailyLockService.js";
import { STARTER_VOCABULARY } from "./data/starterVocabulary.js";
import { STARTER_SITUATIONS } from "./data/starterSituations.js";

if (typeof window !== "undefined") {
  primeVoices();
  // eslint-disable-next-line no-console
  console.log("%cحصيلتي (Hasila) — Original work by Angelos Onsy", "color:#C99A3F;font-weight:bold;");
}

/* ---------------- Storage helpers ---------------- */
const todayStr = () => new Date().toISOString().slice(0, 10);

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

/* ---------------- Android back button ----------------
   Overlays (settings, quiz, dialogs...) register a close handler while they
   are mounted. The hardware back button always closes the top-most overlay
   first; only when none is open does it go back through the tab history. */
const backHandlers = [];
function useBackClose(onClose, active = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    const h = () => ref.current && ref.current();
    backHandlers.push(h);
    return () => { const i = backHandlers.lastIndexOf(h); if (i >= 0) backHandlers.splice(i, 1); };
  }, [active]);
}

const VALID_TABS = ["dashboard", "dictionary", "flashcards", "situations", "add", "stats", "weak", "leeches"];
const TAB_KEY = "hasila-last-tab";
function readLastTab() {
  try { const t = localStorage.getItem(TAB_KEY); return VALID_TABS.includes(t) ? t : "dashboard"; } catch { return "dashboard"; }
}
function writeLastTab(t) { try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ } }

/* A small fixed sample used by the placement quiz to gauge which of the
   user's own UNKNOWN words they already actually know, so those don't
   waste early review slots starting from zero. Deliberately reuses the
   user's own vocabulary (not a separate CEFR word bank) - see
   PlacementQuiz below. */
function samplePlacementWords(words, count = 20) {
  const candidates = words.filter((w) => (w.bucket || "Unknown") === "Unknown" && !w.placementDone);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/* ---------------- Pronunciation ----------------
   All speech logic now lives in services/PronunciationService.js - this is
   just the button component that calls it. See that file for why the call
   must stay synchronous inside the click handler. */
function SpeakButton({ word, size = 15, color = "#3a6b5c", withLabel = false, accent = "us", label = "استمع", title }) {
  const [state, setState] = useState("idle"); // idle | unsupported-device | error
  const handle = async (e) => {
    e.stopPropagation();
    const result = await speak(word, { accent });
    setState(result.ok ? "idle" : (result.reason || "error"));
    if (!result.ok) setTimeout(() => setState("idle"), 1800);
  };
  const errorLabel = { "unsupported-device": "النطق غير مدعوم على هذا الجهاز", error: "تعذر النطق" };
  const isError = state !== "idle";
  return (
    <button
      onClick={handle}
      title={title}
      style={{ background: withLabel ? "#16302B10" : "none", border: "none", borderRadius: withLabel ? 20 : 0, padding: withLabel ? "6px 12px" : 2, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
    >
      <Volume2 size={size} color={isError ? "#c1785b" : color} />
      {withLabel && <span style={{ fontSize: 12, color }}>{isError ? (errorLabel[state] || "تعذر النطق") : label}</span>}
    </button>
  );
}

/* Highlights a situation's target word within its full phrase (case-
   insensitive match). Falls back to plain text if there's no target word
   or it isn't actually found in the phrase (e.g. different inflection). */
function PhraseText({ phrase, targetWord, style }) {
  if (!targetWord) return <span className="eng" style={style}>{phrase}</span>;
  const idx = phrase.toLowerCase().indexOf(targetWord.toLowerCase());
  if (idx === -1) return <span className="eng" style={style}>{phrase}</span>;
  const before = phrase.slice(0, idx);
  const match = phrase.slice(idx, idx + targetWord.length);
  const after = phrase.slice(idx + targetWord.length);
  return (
    <span className="eng" style={style}>
      {before}<strong style={{ color: "#A97A1E" }}>{match}</strong>{after}
    </span>
  );
}

/* ---------------- Fonts / global style ----------------
   (Daily reminder scheduling now lives in services/SettingsService.js.) */
const GlobalStyle = () => (
  <style>{`
        .vocab-root { font-family: 'Cairo', sans-serif; }
    .vocab-root .eng { font-family: 'Space Mono', monospace; }
    .vocab-root .display { font-family: 'Cairo', sans-serif; }
    .vocab-root ::selection { background: #C99A3F55; }
    body { margin: 0; background: #F5F3EB; }
    .vocab-root button, .vocab-root input, .vocab-root select, .vocab-root textarea { font-family: inherit; }
    .vocab-root button:focus-visible, .vocab-root input:focus-visible, .vocab-root textarea:focus-visible, .vocab-root select:focus-visible {
      outline: 2px solid #C99A3F; outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .vocab-root * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
    }
    .card-flip { transform-style: preserve-3d; transition: transform 0.5s cubic-bezier(.4,.2,.2,1); }
    .card-flip.flipped { transform: rotateY(180deg); }
    .card-face { backface-visibility: hidden; }
    .card-face.back { transform: rotateY(180deg); }
    @keyframes pulseIn {
      0% { opacity: 0; transform: scale(0.85); }
      40% { opacity: 1; transform: scale(1.05); }
      100% { opacity: 1; transform: scale(1); }
    }
  `}</style>
);

/* ---------------- Main App ----------------
   Default settings now live in services/SettingsService.js. */

export default function VocabApp() {
  const [data, setData] = useState({ words: [], situations: [], streak: initialStreak(), settings: DEFAULT_SETTINGS, starterContentSeeded: false, pendingFirstWordSession: false, pendingFirstSituationSession: false, situationsReviewedDate: null, wordsSessionUsedDate: null, wordsUnlockedDate: null, situationsSessionUsedDate: null, situationsUnlockedDate: null });
  const [loaded, setLoaded] = useState(false);
  const [tab, setTabRaw] = useState(readLastTab);
  const navStack = useRef([]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // Plain tab change that records history so Android back can retrace it.
  const setTab = useCallback((next) => {
    if (next === tabRef.current) return;
    navStack.current.push(tabRef.current);
    if (navStack.current.length > 30) navStack.current.shift();
    tabRef.current = next;
    writeLastTab(next);
    setTabRaw(next);
  }, []);
  const [toast, setToast] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlacement, setShowPlacement] = useState(false);
  const [celebration, setCelebration] = useState(null); // milestone day-count, or null
  const [premiumFor, setPremiumFor] = useState(null); // "words" | "situations" | null
  const dataRef = useRef(null);
  const [quickMode, setQuickMode] = useState(false);
  const [listenMode, setListenMode] = useState(false);
  const saveTimer = useRef(null);
  dataRef.current = data;

  useEffect(() => {
    // StorageService.loadData() also runs schema migration - existing
    // words/situations/settings are preserved, only missing fields get
    // filled in with defaults (see StorageService for the version history).
    const migrated = loadData();
    if (migrated) setData(migrated);
    setLoaded(true);
  }, []);

  const persist = useCallback((next) => {
    setData(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveData(next);
    }, 250);
  }, []);

  useEffect(() => {
    let handle;
    let cancelled = false;
    CapacitorApp.addListener("backButton", () => {
      if (backHandlers.length) { backHandlers[backHandlers.length - 1](); return; }
      if (navStack.current.length) {
        const prev = navStack.current.pop();
        tabRef.current = prev; writeLastTab(prev); setTabRaw(prev);
        return;
      }
      if (tabRef.current !== "dashboard") { tabRef.current = "dashboard"; writeLastTab("dashboard"); setTabRaw("dashboard"); return; }
      CapacitorApp.minimizeApp();
    }).then((h) => { if (cancelled) h.remove(); else handle = h; }).catch(() => {});
    return () => { cancelled = true; if (handle) handle.remove(); };
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const [pendingUndo, setPendingUndo] = useState(null); // { item, timerId } | null

  const undoDelete = () => {
    if (!pendingUndo) return;
    clearTimeout(pendingUndo.timerId);
    persist({ ...data, words: [pendingUndo.item, ...data.words] });
    setPendingUndo(null);
    setToast(null);
  };

  const addWord = (w) => {
    const now = new Date().toISOString();
    const item = {
      id: Math.random().toString(36).slice(2, 10),
      word: w.word.trim(),
      meaning: w.meaning.trim(),
      example: (w.example || "").trim(),
      category: (w.category || "عام").trim(),
      level: (w.level || "").trim(),
      createdAt: now,
      ef: 2.5,
      repetition: 0,
      interval: 0,
      nextReview: todayStr(),
      ...emptyWordExtras(),
    };
    persist({ ...data, words: [item, ...data.words] });
  };

  const bulkAdd = (rows) => {
    const now = new Date().toISOString();
    const items = rows
      .map((r) => ({
        id: Math.random().toString(36).slice(2, 10),
        word: (r.word || "").trim(),
        meaning: (r.meaning || "").trim(),
        example: (r.example || "").trim(),
        category: (r.category || "عام").trim(),
        level: (r.level || "").trim().toUpperCase(),
        createdAt: now,
        ef: 2.5,
        repetition: 0,
        interval: 0,
        nextReview: todayStr(),
        ...emptyWordExtras(),
      }))
      .filter((r) => r.word && r.meaning);
    persist({ ...data, words: [...items, ...data.words] });
    return items.length;
  };

  const deleteWord = (id) => {
    const item = data.words.find((w) => w.id === id);
    if (!item) return;
    persist({ ...data, words: data.words.filter((w) => w.id !== id) });
    if (pendingUndo?.timerId) clearTimeout(pendingUndo.timerId);
    const timerId = setTimeout(() => { setPendingUndo(null); setToast(null); }, 5000);
    setPendingUndo({ item, timerId });
    setToast(`اتمسحت "${item.word}"`);
  };

  const updateSettings = (patch) => {
    const settings = { ...data.settings, ...patch };
    persist({ ...data, settings });
    // Reminder rescheduling happens reactively via ReminderScheduleOnMount
    // (it watches hour/minute/dueCount/habitAnchor), so it isn't repeated
    // here too.
  };

  /**
   * Called once, at the end of onboarding, when the person picks their
   * CEFR level. If they also opted into starter content AND this is
   * genuinely a first run (no existing words/situations, never seeded
   * before), the curated word/situation banks get added in the same
   * atomic persist call that sets the level - so seeding and "don't ever
   * seed again" both land together, never partially.
   *
   * Skipping starter content (or this simply not being eligible, e.g. an
   * existing user somehow re-hitting this screen) still marks
   * starterContentSeeded = true - an explicit "no thanks" must be
   * respected permanently, the same way a declined notification
   * permission shouldn't be re-asked every launch.
   *
   * reminderChoice ({ asked, enabled }) comes from the onboarding
   * notification step - asked records that the OS dialog was shown (or
   * explicitly skipped) so nothing in this app ever prompts again on its
   * own; enabled reflects whether permission actually ended up granted.
   */
  const pickLevelAndSeed = (level, includeStarterContent, reminderChoice) => {
    const settingsPatch = { level };
    if (reminderChoice) {
      settingsPatch.notificationPermissionAsked = reminderChoice.asked;
      settingsPatch.remindersEnabled = reminderChoice.enabled;
    }
    const seedNeeded = includeStarterContent && !data.starterContentSeeded && data.words.length === 0 && data.situations.length === 0;
    if (!seedNeeded) {
      persist({ ...data, settings: { ...data.settings, ...settingsPatch }, starterContentSeeded: true });
      return;
    }
    const now = new Date().toISOString();
    const seededWords = STARTER_VOCABULARY.map((w) => ({
      id: Math.random().toString(36).slice(2, 10),
      word: w.word, meaning: w.meaning, example: w.example || "",
      category: w.category || "عام", level: (w.level || "").toUpperCase(),
      createdAt: now, ef: 2.5, repetition: 0, interval: 0, nextReview: todayStr(),
      ...emptyWordExtras(),
    }));
    const seededSituations = STARTER_SITUATIONS.map((s) => ({
      id: Math.random().toString(36).slice(2, 10),
      situation: s.situation || "عام", level: (s.level || "").toUpperCase(),
      phrase: s.phrase, meaning: s.meaning, targetWord: "",
      createdAt: now, ef: 2.5, repetition: 0, interval: 0, nextReview: todayStr(),
    }));
    persist({
      ...data,
      words: [...seededWords, ...data.words],
      situations: [...seededSituations, ...data.situations],
      settings: { ...data.settings, ...settingsPatch },
      starterContentSeeded: true,
      // The very next time each content type is opened, it gets a small
      // one-time cap (10 words / 3 situations) instead of the normal
      // daily caps - see buildQuickSession/buildQuickSituationSession.
      // Two independent flags because words and situations are separate
      // tabs; whichever the person opens first still gets protected.
      pendingFirstWordSession: true,
      pendingFirstSituationSession: true,
    });
    showToast(`اتضاف ${seededWords.length} كلمة و ${seededSituations.length} موقف جاهزين 🎉`);
  };

  const bumpStreak = () => {
    const { streak, freezeUsed, milestoneHit } = applyDailyStreakUpdate(data.streak, todayStr());
    if (freezeUsed) showToast("🧊 استخدمنا تجميدة عشان نحافظ على سلسلتك - غايب يوم مش نهاية العالم");
    if (milestoneHit) setCelebration(milestoneHit);
    return streak;
  };

  const reviewWord = (id, quality) => {
    // Scheduling (SM-2), performance tracking (successes/failures/streaks),
    // and the bucket state transition are three explicit, separate steps -
    // centralized in services/SM2Engine.js so nothing computes this by
    // hand or duplicates the rules. nextBucket reuses the same
    // consecutiveCorrect/consecutiveFailures counters applyPerformanceTracking
    // already produces, rather than tracking a second parallel streak.
    const words = data.words.map((w) => {
      if (w.id !== id) return w;
      const sm2 = applySM2(w, quality);
      const perf = applyPerformanceTracking(w, quality);
      const bucket = nextBucket(w.bucket || "Unknown", { correctStreak: perf.consecutiveCorrect, wrongStreak: perf.consecutiveFailures });
      return { ...w, ...sm2, ...perf, bucket, lastReview: new Date().toISOString() };
    });
    persist({ ...data, words, streak: bumpStreak() });
  };

  const toggleSuspend = (id) => {
    const words = data.words.map((w) => {
      if (w.id !== id) return w;
      if (w.bucket === "Suspended") {
        // Resume: fall back to a sensible bucket based on progress so far,
        // never straight back into "Weak" just because that's where it was
        // before being suspended - a fresh look is the point of resuming.
        return { ...w, bucket: (w.repetition || 0) > 0 ? "Review" : "Unknown" };
      }
      return { ...w, bucket: "Suspended" };
    });
    persist({ ...data, words });
  };

  const toggleFavorite = (id) => {
    const words = data.words.map((w) => (w.id === id ? { ...w, favorite: !w.favorite } : w));
    persist({ ...data, words });
  };

  const applyPlacement = (results) => {
    // Placement only ever touches words the person explicitly answered in
    // the quiz - everything else in the vocabulary is untouched.
    const byId = Object.fromEntries(results.map((r) => [r.id, r.answer]));
    const words = data.words.map((w) => {
      const answer = byId[w.id];
      if (!answer) return w;
      if (answer === "know") {
        const next = new Date();
        next.setDate(next.getDate() + 6);
        return { ...w, bucket: "Review", repetition: 2, interval: 6, ef: 2.5, consecutiveCorrect: 2, consecutiveFailures: 0, nextReview: next.toISOString().slice(0, 10), placementDone: true };
      }
      if (answer === "unsure") {
        const next = new Date();
        next.setDate(next.getDate() + 1);
        return { ...w, bucket: "Learning", repetition: 0, interval: 1, nextReview: next.toISOString().slice(0, 10), placementDone: true };
      }
      return { ...w, placementDone: true }; // "don't know" - stays a fresh word, due today, bucket unchanged
    });
    persist({ ...data, words });
  };

  /* ---- Situations (separate content, separate array, own SM-2 fields) ---- */
  const addSituation = (s) => {
    const item = {
      id: Math.random().toString(36).slice(2, 10),
      situation: (s.situation || "عام").trim(),
      level: (s.level || "").trim().toUpperCase(),
      phrase: s.phrase.trim(),
      meaning: s.meaning.trim(),
      targetWord: (s.targetWord || "").trim(),
      createdAt: new Date().toISOString(),
      ef: 2.5, repetition: 0, interval: 0, nextReview: todayStr(),
    };
    persist({ ...data, situations: [item, ...data.situations] });
  };

  const bulkAddSituations = (rows) => {
    const items = rows
      .map((r) => ({
        id: Math.random().toString(36).slice(2, 10),
        situation: (r.situation || "عام").trim(),
        level: (r.level || "").trim().toUpperCase(),
        phrase: (r.phrase || "").trim(),
        meaning: (r.meaning || "").trim(),
        targetWord: (r.targetWord || "").trim(),
        createdAt: new Date().toISOString(),
        ef: 2.5, repetition: 0, interval: 0, nextReview: todayStr(),
      }))
      .filter((r) => r.phrase && r.meaning);
    persist({ ...data, situations: [...items, ...data.situations] });
    return items.length;
  };

  const deleteSituation = (id) => persist({ ...data, situations: data.situations.filter((s) => s.id !== id) });

  const reviewSituation = (id, quality) => {
    const situations = data.situations.map((s) => (s.id === id ? { ...s, ...applySM2(s, quality) } : s));
    persist({ ...data, situations, streak: bumpStreak() });
  };

  if (!loaded) {
    return (
      <div className="vocab-root" style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F5F3EB", color: "#1F3D36" }}>
        جارٍ التحميل...
      </div>
    );
  }

  // Reflects the one-time first-session cap too (see pickLevelAndSeed),
  // so the dashboard/header badge count matches what tapping through to
  // Flashcards will actually show.
  const todaySession = data.pendingFirstWordSession ? buildQuickSession(data.words, data.settings, 10) : buildSession(data.words, data.settings);
  const due = { length: todaySession.total, breakdown: todaySession.breakdown };

  // Situation due count (respects first-session cap the same way)
  const todaySituationSession = data.pendingFirstSituationSession
    ? buildQuickSituationSession(data.situations, data.settings, 3)
    : buildSituationSession(data.situations, data.settings);
  const situationsDue = todaySituationSession.total;

  // Daily locks (DailyLockService): words and situations are independent.
  const today = todayStr();
  const wordsLocked = isLocked(data, "words", today);
  const situationsLocked = isLocked(data, "situations", today);
  const wordsBadge = (data.wordsSessionUsedDate !== today && due.length > 0) ? 1 : 0;
  const situationsBadge = (data.situationsSessionUsedDate !== today && situationsDue > 0) ? 1 : 0;

  const completeSession = (kind) => {
    const d = dataRef.current;
    persist({ ...d, ...markSessionComplete(d, kind, todayStr()) });
  };
  const unlockWithAd = (kind) => {
    showRewardedForStreak(() => {
      const d = dataRef.current;
      persist({ ...d, ...unlockPatch(kind, todayStr()) });
      showToast("🔓 اتفتحت جلسة إضافية");
    }, () => showToast("الإعلان مش متاح دلوقتي - جرّب تاني بعد شوية"));
  };
  const navigateTo = setTab;

  if (!data.settings.level) {
    return (
      <div className="vocab-root" dir="rtl" style={{ background: "#F5F3EB", height: "100vh" }}>
        <GlobalStyle />
        <OnboardingLevel onFinish={pickLevelAndSeed} />
      </div>
    );
  }

  return (
    <div className="vocab-root" dir="rtl" style={{ background: "#F5F3EB", height: "100vh", display: "flex", flexDirection: "column", fontFamily: "Cairo, sans-serif", position: "relative" }}>
      <GlobalStyle />
      <ReminderScheduleOnMount
        hour={data.settings.reminderHour}
        minute={data.settings.reminderMinute}
        dueCount={due.length}
        habitAnchor={data.settings.habitAnchor}
        enabled={data.settings.remindersEnabled}
      />
      <Header wordCount={data.words.length} dueCount={due.length} streak={data.streak.count} onOpenSettings={() => setShowSettings(true)} />
      <div style={{ flex: 1, overflowY: "auto", padding: "16px", paddingBottom: 90 }}>
        {tab === "dashboard" && (
          <Dashboard
            data={data}
            due={due}
            goTab={navigateTo}
            wordsLocked={wordsLocked}
            onOpenPlacement={() => setShowPlacement(true)}
            onStartReview={() => { setQuickMode(false); setListenMode(false); setTab("flashcards"); }}
            onStartQuickReview={() => { setQuickMode(true); setListenMode(false); setTab("flashcards"); }}
            onStartListenReview={() => { setQuickMode(false); setListenMode(true); setTab("flashcards"); }}
            onEarnFreeze={() => showRewardedForStreak(() => {
              const s = data.streak;
              if ((s.freezesAvailable ?? 0) < FREEZE_CAP) {
                persist({ ...data, streak: { ...s, freezesAvailable: (s.freezesAvailable ?? 0) + 1 } });
                showToast("🧊 حصلت على تجميدة إضافية!");
              } else {
                showToast("عندك الحد الأقصى من التجميدات بالفعل");
              }
            }, () => showToast("الإعلان مش متاح دلوقتي - جرّب تاني بعد شوية"))}
          />
        )}
        {tab === "dictionary" && <Dictionary words={data.words} onDelete={deleteWord} onToggleSuspend={toggleSuspend} onToggleFavorite={toggleFavorite} onBulkAdd={bulkAdd} accent={data.settings.accent} />}
        {tab === "flashcards" && (
          <Flashcards
            key={`${quickMode}-${listenMode}-${data.wordsUnlockedDate}`}
            locked={wordsLocked}
            onSessionComplete={() => completeSession("words")}
            onUnlock={() => setPremiumFor("words")}
            words={data.words}
            onReview={reviewWord}
            settings={data.settings}
            quick={quickMode}
            listen={listenMode}
            goTab={navigateTo}
            firstSessionPending={data.pendingFirstWordSession}
            onFirstSessionConsumed={() => persist({ ...data, pendingFirstWordSession: false })}
          />
        )}
        {tab === "weak" && (
          <WeakWordsScreen
            words={data.words}
            situations={data.situations}
            settings={data.settings}
            onReview={reviewWord}
            onDelete={deleteWord}
            onToggleSuspend={toggleSuspend}
            onToggleFavorite={toggleFavorite}
            accent={data.settings.accent}
            goTab={navigateTo}
            locked={wordsLocked}
            onUnlock={() => setPremiumFor("words")}
          />
        )}
        {tab === "leeches" && (
          <LeechesScreen
            words={data.words}
            situations={data.situations}
            settings={data.settings}
            onReview={reviewWord}
            onDelete={deleteWord}
            onToggleSuspend={toggleSuspend}
            onToggleFavorite={toggleFavorite}
            accent={data.settings.accent}
            goTab={navigateTo}
            locked={wordsLocked}
            onUnlock={() => setPremiumFor("words")}
          />
        )}
        {tab === "stats" && <Statistics data={data} goTab={navigateTo} />}
        {tab === "situations" && (
          <Situations
            situations={data.situations}
            onAdd={addSituation}
            onBulkAdd={bulkAddSituations}
            onDelete={deleteSituation}
            onReview={reviewSituation}
            accent={data.settings.accent}
            settings={data.settings}
            firstSessionPending={data.pendingFirstSituationSession}
            onFirstSessionConsumed={() => persist({ ...data, pendingFirstSituationSession: false })}
            locked={situationsLocked}
            unlockKey={data.situationsUnlockedDate}
            onSessionComplete={() => completeSession("situations")}
            onUnlock={() => setPremiumFor("situations")}
          />
        )}
        {tab === "add" && (
          <AddWord
            onAdd={addWord}
            onBulkAdd={bulkAdd}
            existingWords={data.words}
            onDone={(msg) => {
              showToast(msg);
              setTab("dictionary");
            }}
          />
        )}
      </div>
      <BottomNav tab={tab} setTab={navigateTo} wordsBadge={wordsBadge} situationsBadge={situationsBadge} />
      {toast && (
        <div style={{ position: "absolute", bottom: 80, left: "50%", transform: "translateX(-50%)", background: "#3a6b5c", color: "#FBF6EA", padding: "8px 16px", borderRadius: 8, fontSize: 14, boxShadow: "0 4px 12px rgba(0,0,0,.3)", zIndex: 10, display: "flex", alignItems: "center", gap: 12 }}>
          <span>{toast}</span>
          {pendingUndo && (
            <button
              onClick={undoDelete}
              style={{ background: "none", border: "none", color: "#A97A1E", fontWeight: 700, cursor: "pointer", fontSize: 14, padding: 0 }}
            >
              تراجع
            </button>
          )}
        </div>
      )}
      {showSettings && (
        <SettingsModal
          settings={data.settings}
          appData={data}
          onSave={(patch) => { updateSettings(patch); setShowSettings(false); }}
          onRestore={(restoredData) => { persist(restoredData); showToast("رجّعنا بياناتك بنجاح 🎉"); }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showPlacement && (
        <PlacementQuiz
          words={samplePlacementWords(data.words)}
          accent={data.settings.accent}
          onFinish={(results) => { applyPlacement(results); setShowPlacement(false); showToast("اتسجل تقييمك، الكلمات اتظبطت على أساسه ✅"); }}
          onClose={() => setShowPlacement(false)}
        />
      )}
      {celebration && <MilestoneCelebration count={celebration} onClose={() => setCelebration(null)} />}
      {premiumFor && (
        <PremiumModal
          kind={premiumFor}
          onClose={() => setPremiumFor(null)}
          onWatchAd={() => { const k = premiumFor; setPremiumFor(null); unlockWithAd(k); }}
        />
      )}
    </div>
  );
}

function ReminderScheduleOnMount({ hour, minute, dueCount, habitAnchor, enabled }) {
  useEffect(() => {
    // Never triggers a permission dialog itself - only (re)schedules if
    // the OS already granted permission previously. See
    // SettingsService.scheduleReminder for why.
    scheduleReminder(hour, minute, dueCount, habitAnchor, enabled);
    // Re-fires whenever the reminder time, habit anchor, enabled flag, or
    // today's due count changes (e.g. right after finishing a session) so
    // the scheduled notification's body reflects a reasonably fresh count
    // - see the caveat in SettingsService.scheduleReminder about this
    // being a snapshot, not a live count computed at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour, minute, dueCount, habitAnchor, enabled]);
  return null;
}

/* ---------------- Onboarding: pick current level ---------------- */
/* ---------------- Onboarding ----------------
   A few short explainer slides before the level picker, for a first-time
   user who's never seen a spaced-repetition app before - what the app
   actually does and why words move between states, not just "pick your
   level and go". */
const ONBOARDING_SLIDES = [
  { emoji: "📚", title: "أهلاً بيك في حصيلتي 👋", body: "هيساعدك تحفظ كلمات إنجليزي فعليًا، مش بس تشوفها مرة وتنساها بعد ساعة." },
  { emoji: "🧠", title: "التكرار المتباعد", body: "بدل ما تراجع كل الكلمات كل يوم، هتشوف كل كلمة في الوقت المثالي لتثبيتها - قريب لو لسه جديدة، وبعيد أكتر كل ما تثبتها في ذاكرتك." },
  { emoji: "🔄", title: "حالات الكلمة", body: "كل كلمة بتتنقل حسب أدائك: غير مقيّمة ← قيد التعلم ← مراجعة ← متقنة. قلت إنك مش عارفها أو غلطت فيها؟ بتبقى \"ضعيفة\" وتاخد اهتمام إضافي لحد ما تجاوب صح 3 مرات ورا بعض." },
];

function LevelCheckStep({ level, onDone }) {
  const [phase, setPhase] = useState("intro"); // intro | quiz | result
  const [items] = useState(() => pickLevelCheckWords(STARTER_VOCABULARY, level));
  const [answers, setAnswers] = useState([]);
  const wrap = { height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" };
  const ghost = { background: "#E9EFE9", border: "none", borderRadius: 10, padding: "13px 0", color: "#1F3D36", fontSize: 14, cursor: "pointer" };

  if (phase === "intro") {
    return (
      <div style={wrap}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎯</div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 20, fontWeight: 700, marginBottom: 12 }}>تحب تتأكد من مستواك؟</div>
        <div style={{ color: "#1F3D3699", fontSize: 13, maxWidth: 300, lineHeight: 1.8, marginBottom: 28 }}>
          اختبار سريع من {items.length} كلمة حوالين مستوى {level} (دقيقة تقريبًا). هنقولك لو مستواك باين أقرب لمستوى تاني، والقرار في الآخر ليك إنت.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
          <button onClick={() => setPhase("quiz")} style={{ ...primaryBtnStyle, padding: "14px 0" }}>ابدأ الاختبار</button>
          <button onClick={() => onDone(null)} style={ghost}>تخطّي، مستواي {level}</button>
        </div>
      </div>
    );
  }

  if (phase === "quiz") {
    const i = answers.length;
    const it = items[i];
    const answer = (a) => { const next = [...answers, a]; setAnswers(next); if (next.length >= items.length) setPhase("result"); };
    return (
      <div style={wrap}>
        <div style={{ color: "#1F3D3680", fontSize: 12, marginBottom: 14 }} dir="ltr">{i + 1} / {items.length}</div>
        <div className="eng" style={{ color: "#1F3D36", fontSize: 30, fontWeight: 700, marginBottom: 6 }}>{it.word}</div>
        <div style={{ marginBottom: 24 }}><SpeakButton word={it.word} withLabel color="#1F3D36" /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
          <button onClick={() => answer("know")} style={{ ...primaryBtnStyle, padding: "13px 0" }}>أعرفها</button>
          <button onClick={() => answer("unsure")} style={ghost}>مش متأكد</button>
          <button onClick={() => answer("no")} style={ghost}>معرفهاش</button>
        </div>
        <button onClick={() => onDone(null)} style={{ background: "none", border: "none", color: "#1F3D3699", fontSize: 12, marginTop: 22, cursor: "pointer" }}>تخطّي الاختبار</button>
      </div>
    );
  }

  const r = evaluateLevelCheck(items, answers, level);
  const msg = r.verdict === "higher"
    ? `نتيجتك قوية: مستواك باين أقرب لـ ${r.suggested} من ${level}.`
    : r.verdict === "lower"
      ? `الكلمات كانت صعبة شوية على ${level}، ومستواك باين أقرب لـ ${r.suggested}.`
      : `مستواك ${level} مناسب لنتيجتك. 👍`;
  return (
    <div style={wrap}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>{r.verdict === "ok" ? "✅" : "🧭"}</div>
      <div className="display" style={{ color: "#1F3D36", fontSize: 19, fontWeight: 700, marginBottom: 10, maxWidth: 300, lineHeight: 1.6 }}>{msg}</div>
      <div style={{ color: "#1F3D3680", fontSize: 12, marginBottom: 24 }}>
        {Object.entries(r.rates).map(([l, v]) => `${l}: ${Math.round(v * 100)}%`).join("  ·  ")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
        {r.verdict !== "ok" && <button onClick={() => onDone(r.suggested)} style={{ ...primaryBtnStyle, padding: "14px 0" }}>غيّر لـ {r.suggested}</button>}
        <button onClick={() => onDone(null)} style={r.verdict === "ok" ? { ...primaryBtnStyle, padding: "14px 0" } : ghost}>خليني على {level}</button>
      </div>
    </div>
  );
}

function OnboardingLevel({ onFinish }) {
  const [step, setStep] = useState(0);
  const [wantsStarter, setWantsStarter] = useState(null); // true | false | null
  const [pickedLevel, setPickedLevel] = useState(null);

  if (step < ONBOARDING_SLIDES.length) {
    const s = ONBOARDING_SLIDES[step];
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>{s.emoji}</div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 22, fontWeight: 700, marginBottom: 12 }}>{s.title}</div>
        <div style={{ color: "#1F3D3699", fontSize: 14, maxWidth: 300, lineHeight: 1.8, marginBottom: 32 }}>{s.body}</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
          {ONBOARDING_SLIDES.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === step ? "#C99A3F" : "#1F3D3630" }} />
          ))}
        </div>
        <button onClick={() => setStep((st) => st + 1)} style={{ ...primaryBtnStyle, padding: "12px 40px", display: "inline-flex" }}>
          {step === ONBOARDING_SLIDES.length - 1 ? "تمام، يلا نبدأ" : "التالي"}
        </button>
      </div>
    );
  }

  // Step 3: opt-in choice - starter content or start empty. Never forced;
  // whichever button they tap, the choice is respected and never asked
  // again (see pickLevelAndSeed - starterContentSeeded gets set either way).
  if (step === ONBOARDING_SLIDES.length) {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📖</div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 20, fontWeight: 700, marginBottom: 12 }}>تحب تبدأ بمحتوى جاهز؟</div>
        <div style={{ color: "#1F3D3699", fontSize: 13, maxWidth: 300, lineHeight: 1.8, marginBottom: 32 }}>
          عندنا {STARTER_VOCABULARY.length}+ كلمة و{STARTER_SITUATIONS.length}+ موقف عملي جاهزين تقدر تراجعهم فورًا. تقدر تحذف أو تعدّل أي حاجة منهم بعد كده براحتك، أو تبدأ فاضي وتضيف كلماتك بنفسك من الأول.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
          <button onClick={() => { setWantsStarter(true); setStep((st) => st + 1); }} style={{ ...primaryBtnStyle, padding: "14px 0" }}>
            ابدأ بالمحتوى الجاهز
          </button>
          <button
            onClick={() => { setWantsStarter(false); setStep((st) => st + 1); }}
            style={{ background: "#E9EFE9", border: "none", borderRadius: 10, padding: "14px 0", color: "#1F3D36", fontSize: 14, cursor: "pointer" }}
          >
            لأ، هضيف كلماتي بنفسي
          </button>
        </div>
      </div>
    );
  }

  if (step === ONBOARDING_SLIDES.length + 1) {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div className="display" style={{ color: "#1F3D36", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>إيه مستواك الحالي؟</div>
        <div style={{ color: "#1F3D3699", fontSize: 13, marginBottom: 24, maxWidth: 280, lineHeight: 1.7 }}>
          هيتقسملك على أساسه كل يوم: كلمات أقل من مستواك (تثبيت ومراجعة خفيفة)، كلمات في مستواك (المراجعة الأساسية)، وكلمات أعلى منه (جديدة بيتم تقديمها تدريجيًا).
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, width: "100%", maxWidth: 300 }}>
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => { setPickedLevel(l); setStep((st) => st + 1); }}
              style={{ background: "#FFFFFF", border: "none", borderRadius: 10, padding: "14px 0", color: "#16302B", fontSize: 15, fontWeight: 700, cursor: "pointer" }}
            >
              {l}
            </button>
          ))}
        </div>
        <div style={{ color: "#1F3D3699", fontSize: 11, marginTop: 20 }}>ممكن تغيّره بعدين من الإعدادات ⚙️</div>
      </div>
    );
  }

  // Optional level check: a short word test around the chosen level.
  if (step === ONBOARDING_SLIDES.length + 2) {
    return (
      <LevelCheckStep
        level={pickedLevel}
        onDone={(lvl) => { if (lvl) setPickedLevel(lvl); setStep((st) => st + 1); }}
      />
    );
  }

  // Final step: explain the daily reminder and ask for notification
  // permission explicitly - never silently, never repeated later (see
  // notificationPermissionAsked in SettingsService). Skip is always one
  // tap away and the app works completely normally without it.
  const enableReminder = async () => {
    const granted = await requestNotificationPermission();
    onFinish(pickedLevel, wantsStarter, { asked: true, enabled: granted });
  };
  const skipReminder = () => onFinish(pickedLevel, wantsStarter, { asked: false, enabled: false });

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔔</div>
      <div className="display" style={{ color: "#1F3D36", fontSize: 20, fontWeight: 700, marginBottom: 12 }}>فعّل التذكير اليومي</div>
      <div style={{ color: "#1F3D3699", fontSize: 13, maxWidth: 300, lineHeight: 1.8, marginBottom: 32 }}>
        تذكير واحد بسيط في نفس الميعاد كل يوم بيساعدك تستفيد أكتر من التكرار المتباعد. تقدر تغيّر الميعاد أو توقفه في أي وقت من الإعدادات.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
        <button onClick={enableReminder} style={{ ...primaryBtnStyle, padding: "14px 0" }}>فعّل التذكير</button>
        <button onClick={skipReminder} style={{ background: "#E9EFE9", border: "none", borderRadius: 10, padding: "14px 0", color: "#1F3D36", fontSize: 14, cursor: "pointer" }}>
          مش دلوقتي
        </button>
      </div>
    </div>
  );
}

/* Daily caps with a hard rule: new + old + same-level review can never add
   up to more than the session total. Each dropdown only offers values up to
   what is still left of the total, and lowering the total auto-trims. */
function CapsEditor({ title, noun, caps, onChange, totalOptions }) {
  const opts = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const set = (key, v) => onChange(clampCaps({ ...caps, [key]: Number(v) }));
  const field = (key, label) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 130px", minWidth: 130 }}>
      <span style={{ color: "#1F3D3699", fontSize: 12 }}>{label}</span>
      <select value={caps[key]} onChange={(e) => set(key, e.target.value)} style={selectStyle}>
        {opts(capMax(caps, key)).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
  const total = totalOptions.includes(caps.session) ? totalOptions : [...totalOptions, caps.session].sort((a, b) => a - b);
  const used = caps.newC + caps.oldC + caps.review;
  return (
    <>
      <div style={{ color: "#1F3D3699", fontSize: 12, marginTop: 8, fontWeight: 700 }}>{title}</div>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ color: "#1F3D3699", fontSize: 12 }}>أقصى عدد {noun} في اليوم (الإجمالي)</span>
        <select value={caps.session} onChange={(e) => onChange(clampCaps({ ...caps, session: Number(e.target.value) }))} style={selectStyle}>
          {total.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {field("newC", `${noun} جديدة`)}
        {field("oldC", `${noun} قديمة (مراجعة)`)}
        {field("review", "من نفس مستواك")}
      </div>
      <div style={{ color: "#1F3D3699", fontSize: 11 }}>الموزّع {used} من {caps.session} — مجموع الثلاثة ما يزيدش عن الإجمالي.</div>
    </>
  );
}

/* ---------------- Banner ad slot ----------------
   Mounted only on screens that aren't a review session (Settings, Add).
   On native it shows/hides the real top banner for as long as this
   component stays mounted; on web/preview there's no native banner, so a
   labeled placeholder box takes its place - both so the layout reserves
   the right space and so it's possible to see at a glance that a banner
   slot exists on this screen. */
function BannerAdSlot({ placement }) {
  const isNativeApp = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  useEffect(() => {
    showBannerAd(placement);
    return () => { hideBannerAd(); };
  }, [placement]);
  if (isNativeApp) return null; // real banner is a native overlay, nothing to render in the DOM
  return (
    <div style={{ background: "#E2E0D6", border: "1px dashed #9DB5A8", borderRadius: 10, padding: "10px 0", textAlign: "center", color: "#1F3D3699", fontSize: 11 }}>
      مساحة إعلان (Banner) — بتظهر فعليًا على جهاز حقيقي بس
    </div>
  );
}

/* ---------------- Settings modal ---------------- */
function SettingsModal({ settings, appData, onSave, onRestore, onClose }) {
  useBackClose(onClose);
  const [level, setLevel] = useState(settings.level);
  const [wordCaps, setWordCaps] = useState(() => clampCaps({ session: settings.dailySessionCap, newC: settings.dailyNewCap, oldC: settings.dailyOldCap, review: settings.dailyReviewCap }));
  const [sitCaps, setSitCaps] = useState(() => clampCaps({ session: settings.dailySituationSessionCap, newC: settings.dailySituationNewCap, oldC: settings.dailySituationOldCap, review: settings.dailySituationReviewCap }));
  const [accent, setAccent] = useState(settings.accent || "us");
  const [time, setTime] = useState(
    `${String(settings.reminderHour).padStart(2, "0")}:${String(settings.reminderMinute).padStart(2, "0")}`
  );
  const [habitAnchor, setHabitAnchor] = useState(settings.habitAnchor || "");
  const [remindersEnabled, setRemindersEnabled] = useState(settings.remindersEnabled !== false);
  const [permissionNote, setPermissionNote] = useState(null);

  const toggleReminders = async (next) => {
    if (next && !settings.notificationPermissionAsked) {
      // First time this person is turning reminders on - this IS the
      // explicit user action that's allowed to trigger the native
      // permission dialog (see SettingsService.requestNotificationPermission).
      const granted = await requestNotificationPermission();
      setPermissionNote(granted ? null : "التطبيق محتاج إذن الإشعارات من إعدادات الجهاز عشان التذكير يشتغل.");
      setRemindersEnabled(granted);
    } else {
      setRemindersEnabled(next);
    }
  };

  const save = () => {
    const [h, m] = time.split(":").map(Number);
    onSave({
      level,
      dailyNewCap: wordCaps.newC,
      dailyOldCap: wordCaps.oldC,
      dailyReviewCap: wordCaps.review,
      dailySessionCap: wordCaps.session,
      dailySituationNewCap: sitCaps.newC,
      dailySituationOldCap: sitCaps.oldC,
      dailySituationReviewCap: sitCaps.review,
      dailySituationSessionCap: sitCaps.session,
      reminderHour: h,
      reminderMinute: m,
      accent,
      habitAnchor: habitAnchor.trim(),
      remindersEnabled,
      notificationPermissionAsked: settings.notificationPermissionAsked || remindersEnabled,
    });
  };

  const [restoreMsg, setRestoreMsg] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const fileInputRef = useRef(null);

  const handleExportBackup = () => {
    downloadBackup(appData, `hasila-backup-${todayStr()}.json`);
  };

  const handleRestoreFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseBackup(String(reader.result));
      if (!result.ok) {
        setRestoreMsg({ ok: false, text: result.error });
        return;
      }
      const confirmed = window.confirm(
        `هيتم استبدال كل بياناتك الحالية بالنسخة اللي في الملف ده (${result.data.words.length} كلمة، ${result.data.situations.length} موقف). متأكد؟`
      );
      if (!confirmed) return;
      onRestore(result.data);
      setRestoreMsg({ ok: true, text: "اتعمل استرجاع للبيانات بنجاح." });
    };
    reader.onerror = () => setRestoreMsg({ ok: false, text: "تعذرت قراءة الملف." });
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000080", display: "flex", alignItems: "flex-end", zIndex: 50 }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#F5F3EB", width: "100%", borderRadius: "20px 20px 0 0", padding: 20,
          display: "flex", flexDirection: "column", gap: 16, boxSizing: "border-box",
          maxHeight: "88vh", overflowY: "auto", WebkitOverflowScrolling: "touch",
          paddingBottom: "max(20px, env(safe-area-inset-bottom))",
        }}
      >
        <div className="display" style={{ color: "#1F3D36", fontSize: 18, fontWeight: 700 }}>الإعدادات</div>
        <BannerAdSlot placement="settings" />

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ color: "#1F3D3699", fontSize: 12 }}>مستواك الحالي</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)} style={selectStyle}>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ color: "#1F3D3699", fontSize: 12 }}>لهجة النطق</span>
          <select value={accent} onChange={(e) => setAccent(e.target.value)} style={selectStyle}>
            <option value="us">أمريكية (US)</option>
            <option value="gb">بريطانية (UK)</option>
          </select>
        </label>

        <CapsEditor title="حدود المراجعة اليومية للكلمات" noun="كلمات" caps={wordCaps} onChange={setWordCaps} totalOptions={[5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100]} />
        <div style={{ color: "#1F3D3699", fontSize: 11, marginTop: -8, lineHeight: 1.6 }}>
          لو استوردت عدد كبير من الكلمات مرة واحدة، الحدود دي بتمنع إغراقك بيها كلها في يوم واحد - الباقي بيتأجل تلقائيًا للمراجعات الجايه.
        </div>
        <CapsEditor title="حدود المراجعة اليومية للمواقف" noun="مواقف" caps={sitCaps} onChange={setSitCaps} totalOptions={[3, 5, 10, 15, 20, 25, 30, 40, 50]} />

        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
          <span style={{ color: "#1F3D3699", fontSize: 12 }}>التذكير اليومي</span>
          <input type="checkbox" checked={remindersEnabled} onChange={(e) => toggleReminders(e.target.checked)} style={{ width: 18, height: 18 }} />
        </label>
        {permissionNote && <div style={{ color: "#c1785b", fontSize: 11 }}>{permissionNote}</div>}

        <label style={{ display: "flex", flexDirection: "column", gap: 6, opacity: remindersEnabled ? 1 : 0.5 }}>
          <span style={{ color: "#1F3D3699", fontSize: 12 }}>ميعاد التذكير اليومي</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!remindersEnabled} style={selectStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, opacity: remindersEnabled ? 1 : 0.5 }}>
          <span style={{ color: "#1F3D3699", fontSize: 12 }}>اربطها بعادة يومية عندك (اختياري)</span>
          <input
            type="text"
            value={habitAnchor}
            onChange={(e) => setHabitAnchor(e.target.value)}
            placeholder="مثال: بعد ما تصلي المغرب"
            disabled={!remindersEnabled}
            style={selectStyle}
          />
          <span style={{ color: "#1F3D3699", fontSize: 11, lineHeight: 1.6 }}>
            ربط عادة جديدة بعادة تانية عندك ثابتة بيخلي التذكر أسهل بكتير من الاعتماد على الوقت بس. هتظهر الجملة دي جوه التذكير اليومي.
          </span>
        </label>

        <button onClick={save} style={{ ...primaryBtnStyle, marginTop: 4 }}>حفظ</button>

        <div style={{ borderTop: "1px solid #E2E0D6", marginTop: 8, paddingTop: 14 }}>
          <div style={{ color: "#1F3D3699", fontSize: 12, fontWeight: 700, marginBottom: 8 }}>نسخة احتياطية كاملة</div>
          <div style={{ color: "#1F3D3699", fontSize: 11, marginBottom: 10, lineHeight: 1.6 }}>
            بتشمل كل حاجة: الكلمات وتقدمك فيها، المواقف، السلسلة اليومية، والإعدادات. غير تصدير CSV اللي بيحفظ الكلمات بس من غير تقدمك في المراجعة.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={handleExportBackup} style={{ ...iconBtnStyle, flex: 1, justifyContent: "center", color: "#1F3D36" }}>
              <Download size={14} color="#1F3D36" style={{ marginLeft: 6 }} /> تصدير نسخة
            </button>
            <button onClick={() => fileInputRef.current?.click()} style={{ ...iconBtnStyle, flex: 1, justifyContent: "center", color: "#1F3D36" }}>
              <Upload size={14} color="#1F3D36" style={{ marginLeft: 6 }} /> استرجاع نسخة
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleRestoreFile} style={{ display: "none" }} />
          </div>
          {restoreMsg && (
            <div style={{ marginTop: 8, fontSize: 12, color: restoreMsg.ok ? "#5c8f7d" : "#c1785b" }}>{restoreMsg.text}</div>
          )}
        </div>

        <div style={{ borderTop: "1px solid #E2E0D6", marginTop: 8, paddingTop: 14 }}>
          <button
            onClick={() => setShowDiagnostics(true)}
            style={{ ...iconBtnStyle, width: "100%", justifyContent: "center", color: "#1F3D36" }}
          >
            <Info size={14} color="#1F3D36" style={{ marginLeft: 6 }} /> تشخيص النطق (لو الصوت مش شغال)
          </button>
        </div>

        <div style={{ textAlign: "center", color: "#1F3D3640", fontSize: 11, marginTop: 6 }}>
          حصيلتي — تطبيق أصلي من تصميم وتطوير Angelos Onsy
        </div>
      </div>
      {showDiagnostics && <PronunciationDiagnostics onClose={() => setShowDiagnostics(false)} />}
    </div>
  );
}

/* ---------------- Pronunciation diagnostics ----------------
   For when someone reports "the pronunciation isn't working" and there's
   no way to physically inspect their device - this surfaces exactly what
   PronunciationService sees on their phone right now: platform, voice
   availability, the last error, and a short event log, plus a one-tap
   test. Doesn't fix anything by itself, just makes the failure visible
   instead of silent. */
function PronunciationDiagnostics({ onClose }) {
  useBackClose(onClose);
  const [diag, setDiag] = useState(() => getDiagnostics());
  const [testResult, setTestResult] = useState(null);

  const refresh = () => setDiag(getDiagnostics());

  const runTest = async () => {
    setTestResult(null);
    const result = await speak("hello", {});
    setTestResult(result);
    setTimeout(refresh, 300);
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      setTestResult({ ok: true, copied: true });
    } catch (e) {
      // clipboard API unavailable/denied - not critical, export still works
    }
  };

  const exportDiagnostics = () => {
    const blob = new Blob([JSON.stringify(diag, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pronunciation-diagnostics.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#F5F3EB", zIndex: 80, display: "flex", flexDirection: "column", padding: 20, overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#1F3D3680", cursor: "pointer", fontSize: 13 }}>إغلاق</button>
        <span className="display" style={{ color: "#1F3D36", fontSize: 16 }}>تشخيص النطق</span>
        <span style={{ width: 40 }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <DiagRow label="المنصة" value={diag.platform} />
        <DiagRow label="نطق أصلي (Native)" value={diag.isNative ? "نعم" : "لا (متصفح/معاينة)"} />
        <DiagRow label="النطق مدعوم؟" value={diag.speechSupported ? "نعم ✓" : "لا ✗"} color={diag.speechSupported ? "#5c8f7d" : "#c1785b"} />
        <DiagRow label="عدد الأصوات المتاحة" value={diag.voiceCount} />
        <DiagRow label="آخر خطأ" value={diag.lastError || "لا يوجد"} color={diag.lastError ? "#c1785b" : "#1F3D3699"} />
      </div>

      <button onClick={runTest} style={{ ...primaryBtnStyle, marginTop: 16 }}>🔊 اختبار النطق الآن (hello)</button>
      {testResult && (
        <div style={{ marginTop: 8, fontSize: 12, color: testResult.ok ? "#5c8f7d" : "#c1785b", textAlign: "center" }}>
          {testResult.copied ? "اتنسخ التشخيص ✓" : testResult.ok ? "نجح النطق ✓" : `فشل: ${testResult.reason || "غير معروف"}`}
        </div>
      )}

      {diag.voices.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ color: "#1F3D3699", fontSize: 12, marginBottom: 8 }}>الأصوات المتاحة ({diag.voices.length})</div>
          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {diag.voices.map((v, i) => (
              <div key={i} className="eng" style={{ fontSize: 11, color: "#1F3D36cc", background: "#E9EFE9", padding: "6px 10px", borderRadius: 6 }}>
                {v.name} ({v.lang}) {v.default ? "★" : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {diag.eventLog.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ color: "#1F3D3699", fontSize: 12, marginBottom: 8 }}>سجل الأحداث الأخيرة</div>
          <div style={{ maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {[...diag.eventLog].reverse().map((e, i) => (
              <div key={i} className="eng" style={{ fontSize: 10, color: "#1F3D3680" }}>
                {new Date(e.time).toLocaleTimeString()} — {e.event}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button onClick={copyDiagnostics} style={{ ...iconBtnStyle, flex: 1, justifyContent: "center", color: "#1F3D36" }}>نسخ التشخيص</button>
        <button onClick={exportDiagnostics} style={{ ...iconBtnStyle, flex: 1, justifyContent: "center", color: "#1F3D36" }}>تصدير JSON</button>
      </div>
    </div>
  );
}

function DiagRow({ label, value, color = "#1F3D36" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", background: "#E9EFE9", borderRadius: 8, padding: "8px 12px" }}>
      <span style={{ color: "#1F3D3680" }}>{label}</span>
      <span style={{ color }}>{String(value)}</span>
    </div>
  );
}

const selectStyle = { background: "#FFFFFF", border: "none", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "#16302B", width: "100%", boxSizing: "border-box" };

/* ---------------- Header ---------------- */
function HeaderScenery() {
  // Soft mountains + sun behind the header text (decorative only).
  return (
    <svg aria-hidden="true" viewBox="0 0 320 90" preserveAspectRatio="xMinYMax slice" style={{ position: "absolute", left: 0, bottom: 0, width: "78%", height: 84, pointerEvents: "none" }}>
      <defs>
        <linearGradient id="hs-fade" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.75" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="hs-mask"><rect width="320" height="90" fill="url(#hs-fade)" /></mask>
      </defs>
      <g mask="url(#hs-mask)">
        <circle cx="212" cy="38" r="9" fill="#F3D88E" opacity="0.9" />
        <polygon points="0,90 0,52 30,34 52,50 84,22 122,56 150,44 186,72 210,90" fill="#CBD8D2" opacity="0.75" />
        <polygon points="0,90 0,66 40,48 70,64 104,40 140,68 176,58 230,90" fill="#B9CCC3" opacity="0.8" />
        <g fill="#9DB5A8" opacity="0.9">
          <polygon points="18,90 24,66 30,90" /><polygon points="28,90 33,72 38,90" /><polygon points="120,90 126,70 132,90" />
        </g>
      </g>
    </svg>
  );
}

function Header({ wordCount, dueCount, streak, onOpenSettings }) {
  return (
    <div style={{ position: "relative", overflow: "hidden", padding: "18px 18px 16px", background: "linear-gradient(180deg, #EEF0E8 0%, #F5F3EB 100%)", borderBottom: "1px solid #E2E0D6" }}>
      <HeaderScenery />
      <div style={{ position: "relative", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h1 className="display" style={{ color: "#1F5C4B", fontSize: 30, fontWeight: 700, margin: 0, lineHeight: 1.2 }}>حصيلتي</h1>
          <span className="eng" style={{ fontSize: 11, color: "#6b7a74" }}>by Angelos Onsy</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingTop: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#E8863A", fontSize: 15, fontWeight: 700 }}>
            <Flame size={20} color="#E8863A" fill="#F6A04D" />
            <span>{streak}</span>
          </div>
          <button onClick={onOpenSettings} aria-label="الإعدادات" style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
            <SettingsIcon size={22} color="#4a5b55" />
          </button>
        </div>
      </div>
      <div style={{ position: "relative", color: "#2c4a42", fontSize: 15, marginTop: 6 }}>
        {wordCount} كلمة محفوظة، {dueCount} للمراجعة اليوم
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
const dashedBtnStyle = { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "transparent", border: "1.5px dashed #9DB5A8", borderRadius: 14, padding: "16px 12px", color: "#1F3D36", fontSize: 14, cursor: "pointer" };
const BUCKET_ORDER = ["Unknown", "Learning", "Weak", "Review", "Mastered", "Suspended"];

/* ---------------- Streak flame + milestone celebration ----------------
   The flame visually grows/brightens with the streak tier (0 / <7 / <30 /
   <100 / 100+) instead of staying a flat icon - a small but real sense of
   "this is growing because of me" (the "satisfying" habit principle).
   Freezes are shown right next to it since they're what protects this
   number from a single busy day wiping it out. */
function FreezeInfoModal({ freezes, onClose }) {
  useBackClose(onClose);
  return (
    <div style={{ position: "fixed", inset: 0, background: "#F5F3EBee", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#FFFFFF", borderRadius: 20, padding: 24, maxWidth: 340, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 44, marginBottom: 8 }}>🧊</div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 19, fontWeight: 700, marginBottom: 10 }}>إيه هي التجميدة؟</div>
        <div style={{ color: "#1F3D36cc", fontSize: 13, lineHeight: 1.9, textAlign: "right" }}>
          التجميدة زي تأمين على سلسلة أيامك 🔥. لو فوّت يوم من غير مراجعة، التطبيق بيستخدم تجميدة واحدة تلقائيًا وسلسلتك مش بتتصفّر.
          <br />• أقصى رصيد: {FREEZE_CAP} تجميدات.
          <br />• بتاخد تجميدة كمكافأة لما توصل لإنجازات السلسلة (7 / 30 / 100 يوم...).
          <br />• أو تاخد واحدة بمشاهدة إعلان قصير لما يخلص رصيدك.
          <br />• لو فوّت أكتر من يوم ورا بعض ومعاكش تجميدات كفاية، السلسلة بتبدأ من جديد.
        </div>
        <div style={{ color: "#A97A1E", fontSize: 12, marginTop: 12 }}>رصيدك دلوقتي: {freezes} 🧊</div>
        <button onClick={onClose} style={{ ...primaryBtnStyle, display: "inline-flex", padding: "10px 28px", marginTop: 16 }}>تمام</button>
      </div>
    </div>
  );
}

function StreakFlame({ streak, reviewedToday, onEarnFreeze }) {
  const [showInfo, setShowInfo] = useState(false);
  const count = streak.count || 0;
  const freezes = streak.freezesAvailable ?? 0;
  let tier;
  if (count === 0) tier = { color: "#5a5148", size: 26, glow: false };
  else if (count < 7) tier = { color: "#EE8B3A", size: 32, glow: false };
  else if (count < 30) tier = { color: "#A97A1E", size: 36, glow: false };
  else if (count < 100) tier = { color: "#e0b23f", size: 42, glow: true };
  else tier = { color: "#ffd45c", size: 48, glow: true };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#D9E6DF", borderRadius: 18, padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Flame
          size={tier.size}
          color={tier.color}
          fill={count > 0 ? tier.color : "none"}
          style={tier.glow ? { filter: `drop-shadow(0 0 8px ${tier.color}aa)` } : undefined}
        />
        <div>
          <div className="display" style={{ color: "#1F3D36", fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{count}</div>
          <div style={{ color: "#1F3D3680", fontSize: 11, marginTop: 2 }}>
            {count === 1 ? "يوم متتالي" : "أيام متتالية"}{reviewedToday ? " · اتسجل النهاردة ✓" : ""}
          </div>
        </div>
      </div>
      {showInfo && <FreezeInfoModal freezes={freezes} onClose={() => setShowInfo(false)} />}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <button onClick={() => setShowInfo(true)} style={{ background: "none", border: "none", color: "#1F3D3680", fontSize: 11, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <Info size={12} /> إيه هي التجميدة؟
        </button>
        {freezes > 0 ? (
          <div title="تجميدات متاحة - بتحافظ على سلسلتك تلقائيًا لو فوّت يوم" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 15 }}>
            {"🧊".repeat(freezes)}
          </div>
        ) : (
          onEarnFreeze && (
            <button
              onClick={onEarnFreeze}
              title="شاهد إعلان واحصل على تجميدة تحمي سلسلتك"
              style={{ background: "none", border: "1px dashed #9DB5A8", borderRadius: 8, padding: "4px 8px", color: "#1F3D3680", fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
            >
              🧊 احصل على تجميدة
            </button>
          )
        )}
      </div>
    </div>
  );
}

const MILESTONE_MESSAGES = { 7: "أسبوع كامل! 🔥", 30: "شهر كامل من الاستمرار! 🏆", 100: "١٠٠ يوم متتالي - إنجاز ضخم 🎉", 365: "سنة كاملة، إنت أسطورة 👑" };

function MilestoneCelebration({ count, onClose }) {
  useBackClose(onClose);
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "#F5F3EBee", zIndex: 70, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}
      onClick={onClose}
    >
      <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
      <div className="display" style={{ color: "#1F3D36", fontSize: 26, fontWeight: 700, marginBottom: 8 }}>{count} يوم متتالي!</div>
      <div style={{ color: "#A97A1E", fontSize: 16, marginBottom: 24 }}>{MILESTONE_MESSAGES[count] || "استمرار رائع!"}</div>
      <div style={{ color: "#1F3D3680", fontSize: 13, marginBottom: 20 }}>🧊 مكافأة: تجميدة إضافية اتضافت لرصيدك (لو معنديش وصلت للحد الأقصى)</div>
      <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ ...primaryBtnStyle, display: "inline-flex", padding: "12px 32px" }}>تمام!</button>
    </div>
  );
}

/* ---------------- Premium Modal ----------------
   Shown when a free user tries to open a second session type in one day.
   Three exits:
   1. Buy Premium ($3.99) — placeholder until Google Play Billing is added.
   2. Watch a rewarded ad — grants one-time access to that session.
   3. Maybe later — dismisses with no action.

   isPremium is stored in settings so the purchase can be persisted once
   real billing is wired. For now it stays false — Phase 2 placeholder. */
function PremiumModal({ kind, onClose, onWatchAd }) {
  useBackClose(onClose);
  const label = kind === "situations" ? "المواقف" : "الكلمات";
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "#F5F3EBee", zIndex: 80, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#FFFFFF", borderRadius: 20, padding: 28, maxWidth: 320, width: "100%" }}
      >
        <div style={{ fontSize: 48, marginBottom: 12 }}>⭐</div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 20, fontWeight: 700, marginBottom: 10 }}>
          جلسة {label} النهاردة خلصت
        </div>
        <div style={{ color: "#1F3D3699", fontSize: 13, lineHeight: 1.8, marginBottom: 24 }}>
          في النسخة المجانية: جلسة {label} واحدة كل يوم، والقفل بيتجدد تلقائيًا بكرة.
          <br />
          تقدر تفتح جلسة إضافية بمشاهدة إعلان، أو تشترك في Premium من غير أي قفل.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Placeholder — real billing in future phase */}
          <button
            style={{ ...primaryBtnStyle, padding: "14px 0", opacity: 0.6, cursor: "not-allowed" }}
            title="قريباً — Google Play Billing"
          >
            ⭐ اشترِ Premium — $3.99
          </button>

          <button
            onClick={onWatchAd}
            style={{ background: "#3a6b5c", border: "none", borderRadius: 12, padding: "13px 0", color: "#FBF6EA", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            🎬 شاهد إعلان وافتح جلسة إضافية
          </button>

          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#1F3D3699", fontSize: 13, cursor: "pointer", padding: "8px 0" }}
          >
            ربما لاحقاً
          </button>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ data, due, wordsLocked, goTab, onOpenPlacement, onStartReview, onStartQuickReview, onStartListenReview, onEarnFreeze }) {
  const bucketCounts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  data.words.forEach((w) => { bucketCounts[w.bucket || "Unknown"] = (bucketCounts[w.bucket || "Unknown"] || 0) + 1; });
  const mastered = bucketCounts.Mastered;
  const needsPlacement = data.words.filter((w) => (w.bucket || "Unknown") === "Unknown" && !w.placementDone).length;
  const reviewedToday = data.streak.last === todayStr();
  const leechCount = findLeeches(data.words).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <StreakFlame streak={data.streak} reviewedToday={reviewedToday} onEarnFreeze={onEarnFreeze} />

      <div
        role="button"
        onClick={onStartReview}
        style={{ display: "flex", alignItems: "center", gap: 14, background: wordsLocked ? "#E4E3DC" : due.length ? "#FFE7A8" : "#DFE8E2", borderRadius: 18, padding: "22px 20px", cursor: "pointer" }}
      >
        {wordsLocked ? <Lock size={34} color="#6b7a74" /> : <Sprout size={34} color="#3f8a52" />}
        <div style={{ flex: 1 }}>
          <div className="display" style={{ color: "#1F3D36", fontSize: 20, fontWeight: 700, lineHeight: 1.4 }}>
            {wordsLocked
              ? "خلصت جلسة النهاردة 🔒"
              : due.length > 0 ? `عندك ${due.length} كلمة جاهزة للمراجعة` : "لا توجد مراجعات مستحقة الآن"}
          </div>
          <div style={{ color: "#6b5d33", fontSize: 13, marginTop: 4 }}>
            {wordsLocked
              ? "بتتفتح تاني بكرة تلقائيًا، أو افتح جلسة إضافية بإعلان"
              : due.length > 0
                ? `تثبيت ${due.breakdown.known} · مراجعة ${due.breakdown.review} · جديد ${due.breakdown.new}`
                : "أضف كلمات جديدة أو راجع القاموس"}
          </div>
        </div>
      </div>

      {due.length > 0 && !reviewedToday && !wordsLocked && (
        <button onClick={onStartQuickReview} style={dashedBtnStyle}>
          <Zap size={20} color="#E8A93A" fill="#F6C453" />
          <span>مستعجل؟ راجع ٥ كلمات بس وحافظ على سلسلتك.</span>
        </button>
      )}
      {due.length > 0 && !wordsLocked && (
        <button onClick={onStartListenReview} style={dashedBtnStyle}>
          <Headphones size={20} color="#1F3D36" />
          <span>وضع الاستماع - اسمع الكلمة وافتكر معناها</span>
        </button>
      )}
      {!reviewedToday && !wordsLocked && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "#4f7a6a", fontSize: 13 }}>
          <Check size={16} /> كلمة واحدة تكفي علشان يومك يتسجل
        </div>
      )}

      {needsPlacement > 0 && (
        <button
          onClick={onOpenPlacement}
          style={{ display: "flex", alignItems: "center", gap: 10, background: "#D9E6DF", border: "none", borderRadius: 18, padding: "18px 18px", cursor: "pointer", textAlign: "right" }}
        >
          <GraduationCap size={20} color="#A97A1E" />
          <div style={{ flex: 1 }}>
            <div style={{ color: "#1F3D36", fontSize: 13, fontWeight: 700 }}>عندك {needsPlacement} كلمة لسه ما اتقيّمتش</div>
            <div style={{ color: "#1F3D3680", fontSize: 11, marginTop: 2 }}>قيّم اللي تعرفه منها عشان ميبدأش من الصفر في المراجعة</div>
          </div>
        </button>
      )}

      <div>
        <div className="display" style={{ color: "#1F3D36", fontSize: 17, fontWeight: 700, marginBottom: 10 }}>مستوى الحفظ</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {BUCKET_ORDER.filter((b) => b !== "Suspended" || bucketCounts.Suspended > 0).map((b) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 90, fontSize: 12, color: "#1F3D36aa" }}>{BUCKET_LABEL[b]}</div>
              <div style={{ flex: 1, background: "#E2E4DE", borderRadius: 8, height: 12, overflow: "hidden" }}>
                <div style={{ width: `${data.words.length ? (bucketCounts[b] / data.words.length) * 100 : 0}%`, background: BUCKET_COLOR[b], height: "100%" }} />
              </div>
              <div style={{ width: 24, fontSize: 12, color: "#1F3D36aa", textAlign: "left" }}>{bucketCounts[b]}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <StatCard label="إجمالي الكلمات" value={data.words.length} />
        <StatCard label="متقنة" value={mastered} />
        <StatCard label="أيام متتالية" value={data.streak.count} />
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => goTab("stats")}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#E9EFE9", border: "none", borderRadius: 12, padding: "12px 8px", color: "#1F3D36", fontSize: 13, cursor: "pointer" }}
        >
          <LayoutGrid size={15} /> الإحصائيات
        </button>
        <button
          onClick={() => goTab("weak")}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: bucketCounts.Weak ? "#c1785b22" : "#E9EFE9", border: "none", borderRadius: 12, padding: "12px 8px", color: bucketCounts.Weak ? "#c1785b" : "#1F3D36", fontSize: 13, cursor: "pointer" }}
        >
          الكلمات الضعيفة {bucketCounts.Weak > 0 ? `(${bucketCounts.Weak})` : ""}
        </button>
      </div>
      {leechCount > 0 && (
        <button
          onClick={() => goTab("leeches")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#8a5a3f22", border: "1px dashed #8a5a3f55", borderRadius: 12, padding: "12px 8px", color: "#c99a7a", fontSize: 13, cursor: "pointer" }}
        >
          <AlertTriangle size={14} /> {leechCount} كلمة عالقة محتاجة أسلوب تاني
        </button>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={{ flex: 1, background: "#E9EFE9", borderRadius: 12, padding: "12px 10px", textAlign: "center" }}>
      <div className="display" style={{ color: "#1F3D36", fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ color: "#1F3D3680", fontSize: 11, marginTop: 2 }}>{label}</div>
    </div>
  );
}

/* ---------------- Placement Quiz ----------------
   Asks a simple three-way question per never-tested word (know / unsure /
   don't know) - no meaning shown, so it's a genuine recall check, not a
   recognition hint. Answers apply all at once via onFinish (see
   applyPlacement in VocabApp), giving each word a sensible SM-2 starting
   point instead of treating every newly imported word as equally unknown
   on day one. */
function PlacementQuiz({ words, accent, onFinish, onClose }) {
  useBackClose(onClose);
  const [batch] = useState(() => words);
  const [pos, setPos] = useState(0);
  const [results, setResults] = useState([]);

  if (batch.length === 0) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#F5F3EB", zIndex: 60, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ color: "#1F3D3680", fontSize: 14 }}>مفيش كلمات محتاجة تقييم دلوقتي.</div>
        <button onClick={onClose} style={{ ...primaryBtnStyle, marginTop: 16, display: "inline-flex", padding: "10px 20px" }}>رجوع</button>
      </div>
    );
  }

  if (pos >= batch.length) {
    const know = results.filter((r) => r.answer === "know").length;
    const unsure = results.filter((r) => r.answer === "unsure").length;
    const dontknow = results.filter((r) => r.answer === "dontknow").length;
    return (
      <div style={{ position: "fixed", inset: 0, background: "#F5F3EB", zIndex: 60, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", gap: 16 }}>
        <Check size={40} color="#3a6b5c" />
        <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>تم التقييم</div>
        <div style={{ color: "#1F3D3680", fontSize: 13 }}>أعرفها {know} · مش متأكد {unsure} · لأ {dontknow}</div>
        <button onClick={() => onFinish(results)} style={{ ...primaryBtnStyle, display: "inline-flex", padding: "10px 24px" }}>تم</button>
      </div>
    );
  }

  const word = batch[pos];
  const answer = (value) => {
    setResults((r) => [...r, { id: word.id, answer: value }]);
    setPos((p) => p + 1);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#F5F3EB", zIndex: 60, display: "flex", flexDirection: "column", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#1F3D3680", cursor: "pointer", fontSize: 13 }}>إلغاء</button>
        <span style={{ color: "#1F3D3680", fontSize: 12 }} dir="ltr">{pos + 1} / {batch.length}</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <div style={{ color: "#1F3D3699", fontSize: 13 }}>تعرف الكلمة دي؟</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="eng" style={{ fontSize: 28, fontWeight: 700, color: "#1F3D36" }}>{word.word}</span>
          <SpeakButton word={word.word} size={20} color="#1F3D36" accent={accent} />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => answer("know")} style={{ ...primaryBtnStyle, background: "#3a6b5c", color: "#FBF6EA" }}>أعرفها</button>
        <button onClick={() => answer("unsure")} style={{ ...primaryBtnStyle, background: "#c99a3f", color: "#16302B" }}>مش متأكد</button>
        <button onClick={() => answer("dontknow")} style={{ ...primaryBtnStyle, background: "#c1785b", color: "#FBF6EA" }}>لأ، مش عارفها</button>
      </div>
    </div>
  );
}

/* ---------------- Dictionary (grouped by category) ---------------- */
function Dictionary({ words, onDelete, onToggleSuspend, onToggleFavorite, onBulkAdd, accent }) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState({});
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [levelFilter, setLevelFilter] = useState("");
  const [bucketFilter, setBucketFilter] = useState("");

  const exportCSV = () => {
    downloadCSV(exportWordsCSV(words), "my-vocab.csv");
  };

  const favSort = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);

  const searching = q.trim().length > 0;
  let filtered = searching
    ? words.filter((w) => w.word.toLowerCase().includes(q.toLowerCase()) || w.meaning.includes(q) || w.category.includes(q))
    : words;
  if (favoritesOnly) filtered = filtered.filter((w) => w.favorite);
  if (levelFilter) filtered = filtered.filter((w) => (w.level || "").toUpperCase() === levelFilter);
  if (bucketFilter) filtered = filtered.filter((w) => (w.bucket || "Unknown") === bucketFilter);
  filtered = [...filtered].sort(favSort);

  const groups = {};
  filtered.forEach((w) => {
    const cat = w.category || "عام";
    (groups[cat] = groups[cat] || []).push(w);
  });
  const categoryNames = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  const toggle = (cat) => setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  const favoriteCount = words.filter((w) => w.favorite).length;
  const levelsPresent = LEVELS.filter((l) => words.some((w) => (w.level || "").toUpperCase() === l));
  const filtersActive = favoritesOnly || levelFilter || bucketFilter;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", background: "#E9EFE9", borderRadius: 10, padding: "8px 10px" }}>
          <Search size={16} color="#1F3D3680" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث عن كلمة أو تصنيف..."
            style={{ background: "transparent", border: "none", color: "#1F3D36", marginRight: 8, flex: 1, outline: "none", fontSize: 14 }}
          />
        </div>
        {favoriteCount > 0 && (
          <button
            onClick={() => setFavoritesOnly((f) => !f)}
            title="المفضلة فقط"
            style={{ ...iconBtnStyle, background: favoritesOnly ? "#C99A3F33" : iconBtnStyle.background }}
          >
            <Star size={16} color="#A97A1E" fill={favoritesOnly ? "#C99A3F" : "none"} />
          </button>
        )}
        <button onClick={exportCSV} title="تصدير CSV" style={iconBtnStyle}>
          <Download size={16} color="#1F3D36" />
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} style={{ ...selectStyle, width: "auto", flex: "1 1 100px", background: "#E9EFE9", color: "#1F3D36" }}>
          <option value="">كل المستويات</option>
          {levelsPresent.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value)} style={{ ...selectStyle, width: "auto", flex: "1 1 100px", background: "#E9EFE9", color: "#1F3D36" }}>
          <option value="">كل الحالات</option>
          {BUCKET_ORDER.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
        </select>
        {filtersActive && (
          <button
            onClick={() => { setFavoritesOnly(false); setLevelFilter(""); setBucketFilter(""); }}
            style={{ background: "none", border: "none", color: "#c1785b", fontSize: 12, cursor: "pointer", padding: "0 6px" }}
          >
            مسح الفلاتر
          </button>
        )}
      </div>

      {words.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px 16px" }}>
          <div style={{ color: "#1F3D3699", fontSize: 14, marginBottom: 14, lineHeight: 1.7 }}>
            لا توجد كلمات بعد. ابدأ بإضافة كلمتك الأولى من تبويب "إضافة"، أو جرّب بنك الكلمات الجاهز.
          </div>
          <button
            onClick={() => onBulkAdd(STARTER_VOCABULARY)}
            style={{ ...primaryBtnStyle, display: "inline-flex", padding: "10px 20px" }}
          >
            أضف {STARTER_VOCABULARY.length} كلمة جاهزة
          </button>
        </div>
      )}
      {words.length > 0 && filtersActive && filtered.length === 0 && (
        <div style={{ textAlign: "center", color: "#1F3D3699", padding: "20px 0", fontSize: 13 }}>مفيش كلمات مطابقة للفلاتر دي.</div>
      )}

      {searching ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((w) => <WordCard key={w.id} w={w} onDelete={onDelete} onToggleSuspend={onToggleSuspend} onToggleFavorite={onToggleFavorite} accent={accent} />)}
          {filtered.length === 0 && words.length > 0 && (
            <div style={{ textAlign: "center", color: "#1F3D3699", padding: "20px 0", fontSize: 13 }}>مفيش نتائج مطابقة</div>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {categoryNames.map((cat) => {
            const isOpen = !!expanded[cat];
            return (
              <div key={cat} style={{ background: "#E9EFE9", borderRadius: 12, overflow: "hidden" }}>
                <button
                  onClick={() => toggle(cat)}
                  style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: "12px 14px", cursor: "pointer" }}
                >
                  <span style={{ color: "#1F3D36", fontSize: 14, fontWeight: 700 }}>{cat}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#1F3D3680", fontSize: 12 }}>{groups[cat].length}</span>
                    {isOpen ? <ChevronDown size={16} color="#1F3D3680" /> : <ChevronLeft size={16} color="#1F3D3680" />}
                  </div>
                </button>
                {isOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 10px 10px" }}>
                    {groups[cat].map((w) => <WordCard key={w.id} w={w} onDelete={onDelete} onToggleSuspend={onToggleSuspend} onToggleFavorite={onToggleFavorite} accent={accent} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WordCard({ w, onDelete, onToggleSuspend, onToggleFavorite, accent }) {
  const suspended = w.bucket === "Suspended";
  const isLeech = (w.failureCount || 0) >= LEECH_THRESHOLD && !suspended;
  return (
    <div style={{ background: "#FFFFFF", borderRadius: 12, padding: "12px 14px", opacity: suspended ? 0.6 : 1, border: isLeech ? "1px solid #c1785b55" : "1px solid transparent" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="eng" style={{ fontSize: 17, fontWeight: 700, color: "#16302B" }}>{w.word}</span>
            <SpeakButton word={w.word} accent={accent} />
          </div>
          <div style={{ color: "#4a4038", fontSize: 14, marginTop: 2 }}>{w.meaning}</div>
          {w.example && <div style={{ color: "#8a8074", fontSize: 12, marginTop: 4, fontStyle: "italic" }}>{w.example}</div>}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {onToggleFavorite && (
            <button
              onClick={() => onToggleFavorite(w.id)}
              title={w.favorite ? "إزالة من المفضلة" : "إضافة للمفضلة"}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
            >
              <Star size={15} color="#A97A1E" fill={w.favorite ? "#C99A3F" : "none"} />
            </button>
          )}
          <button
            onClick={() => onToggleSuspend(w.id)}
            title={suspended ? "استرجاع من التجاهل" : "تجاهل مؤقتًا من المراجعة"}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
          >
            {suspended ? <EyeOff size={15} color="#8a8074" /> : <Eye size={15} color="#8a807480" />}
          </button>
          <button onClick={() => onDelete(w.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <Trash2 size={15} color="#c1785b" />
          </button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, background: "#16302B12", color: "#16302B99", padding: "2px 8px", borderRadius: 20 }}>{w.category}</span>
        {w.level && <span style={{ fontSize: 10, background: "#C99A3F22", color: "#8a6a1f", padding: "2px 8px", borderRadius: 20 }}>{w.level}</span>}
        <span style={{ fontSize: 10, color: BUCKET_COLOR[w.bucket || "Unknown"] }}>● {BUCKET_LABEL[w.bucket || "Unknown"]}</span>
        {isLeech && (
          <span style={{ fontSize: 10, color: "#c1785b", display: "flex", alignItems: "center", gap: 3 }}>
            <AlertTriangle size={10} /> عالقة ({w.failureCount} غلطة)
          </span>
        )}
      </div>
    </div>
  );
}

const iconBtnStyle = { background: "#E9EFE9", border: "none", borderRadius: 10, padding: "8px 10px", cursor: "pointer", display: "flex", alignItems: "center" };

/* ---------------- Flashcards ----------------
   The review session is frozen when you enter the tab: the total count and
   the queue of words don't shrink as you answer, so the counter climbs
   (1/10, 2/10...) instead of the remaining total shrinking downward.
   Session building itself (bucketing, daily caps, prioritization) lives in
   services/SchedulerService.js - see buildSession there. */
function LockedScreen({ kind, onUnlock, onBack }) {
  const label = kind === "situations" ? "المواقف" : "الكلمات";
  return (
    <div style={{ textAlign: "center", color: "#1F3D3680", padding: "50px 20px" }}>
      <div style={{ fontSize: 44, marginBottom: 10 }}>🔒</div>
      <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>خلصت جلسة {label} النهاردة</div>
      <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.8 }}>
        جلسة {label} بتتفتح من جديد بكرة تلقائيًا.<br />أو افتح جلسة إضافية دلوقتي بإعلان قصير.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 20, maxWidth: 320, marginInline: "auto" }}>
        <button onClick={onUnlock} style={{ background: "#C99A3F", border: "none", borderRadius: 10, padding: "12px 20px", color: "#16302B", fontWeight: 700, cursor: "pointer" }}>🔓 افتح الجلسة</button>
        {onBack && <button onClick={onBack} style={{ background: "#E9EFE9", border: "none", borderRadius: 10, padding: "10px 20px", color: "#1F3D36", cursor: "pointer" }}>رجوع</button>}
      </div>
    </div>
  );
}

function Flashcards({ words, onReview, settings, quick = false, listen = false, goTab, firstSessionPending = false, onFirstSessionConsumed, locked = false, onSessionComplete, onUnlock }) {
  const [session, setSession] = useState(null); // { ids: [...], total, breakdown }
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [motivation] = useState(() => getRandomMotivation());
  const wordMap = Object.fromEntries(words.map((w) => [w.id, w]));
  const completedRef = useRef(false);
  const [completedHere, setCompletedHere] = useState(false);

  // One completed session locks further word reviews for the day. Marked
  // exactly once per mount, only for a session that actually had cards.
  useEffect(() => {
    if (session && session.total > 0 && pos >= session.total && !completedRef.current) {
      completedRef.current = true;
      setCompletedHere(true);
      if (onSessionComplete) onSessionComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, session]);

  useEffect(() => {
    if (session === null && !locked) {
      // The very first session after starter-content seeding gets a small
      // one-time cap (10 words) regardless of quick/normal mode - unless
      // quick mode's own cap (5) is already smaller, in which case quick
      // mode's builder is used as-is (it already satisfies the ≤10 goal).
      // Either way, once this session is built, the pending flag is
      // consumed so every session after this one uses the normal caps.
      const built = quick
        ? buildQuickSession(words, settings)
        : firstSessionPending
          ? buildQuickSession(words, settings, 10)
          : buildSession(words, settings);
      setSession(built);
      if (firstSessionPending && onFirstSessionConsumed) onFirstSessionConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (locked && !completedHere) return <LockedScreen kind="words" onUnlock={onUnlock} onBack={() => goTab && goTab("dashboard")} />;
  if (session === null) return null;

  if (session.total === 0) {
    return (
      <div style={{ textAlign: "center", color: "#1F3D3680", padding: "60px 20px" }}>
        <Check size={40} color="#3a6b5c" style={{ marginBottom: 10 }} />
        <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>خلصت مراجعة النهاردة 🎉</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>ارجع بكرة لمراجعة جديدة، أو أضف كلمات أكتر.</div>
      </div>
    );
  }

  if (pos >= session.total) {
    return (
      <div style={{ textAlign: "center", color: "#1F3D3680", padding: "60px 20px" }}>
        <Check size={40} color="#3a6b5c" style={{ marginBottom: 10 }} />
        <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>راجعت {session.total} كلمة 👏</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>عمل رائع، استمر كده كل يوم.</div>
        {session.deferred > 0 && (
          <div style={{ fontSize: 12, marginTop: 6, color: "#A97A1E" }}>
            🕓 وفيه {session.deferred} كلمة كمان مستنية، هتيجي في مراجعة تانية.
          </div>
        )}
        <div style={{ marginTop: 20, background: "#E9EFE9", borderRadius: 12, padding: "14px 18px", maxWidth: 320, marginInline: "auto" }}>
          <div className="eng" style={{ color: "#A97A1E", fontSize: 13, fontStyle: "italic" }}>"{motivation.en}"</div>
          <div style={{ color: "#1F3D3680", fontSize: 12, marginTop: 6 }}>{motivation.ar}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, maxWidth: 320, marginInline: "auto" }}>
          {locked ? (
            <button
              onClick={onUnlock}
              style={{ background: "#C99A3F", border: "none", borderRadius: 10, padding: "10px 20px", color: "#16302B", fontWeight: 700, cursor: "pointer" }}
            >
              🔓 جلسة إضافية بإعلان
            </button>
          ) : (
            <button
              onClick={() => { setSession(quick ? buildQuickSession(words, settings) : buildSession(words, settings)); setPos(0); completedRef.current = false; setCompletedHere(false); }}
              style={{ background: "#C99A3F", border: "none", borderRadius: 10, padding: "10px 20px", color: "#16302B", fontWeight: 700, cursor: "pointer" }}
            >
              تحقق من مراجعات جديدة
            </button>
          )}
          {goTab && (
            <button
              onClick={() => goTab("situations")}
              style={{ background: "#E9EFE9", border: "none", borderRadius: 10, padding: "10px 20px", color: "#1F3D36", fontWeight: 700, cursor: "pointer" }}
            >
              جرّب موقف واحد كمان؟ 💬
            </button>
          )}
        </div>
      </div>
    );
  }

  const word = wordMap[session.ids[pos]];
  if (!word) {
    // word was deleted mid-session, skip it
    setPos((p) => p + 1);
    return null;
  }

  const handle = (quality) => {
    onReview(word.id, quality);
    setFlipped(false);
    setPos((p) => p + 1);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, paddingTop: 10 }}>
      <div style={{ width: "100%", maxWidth: 320, background: "#E9EFE9", borderRadius: 6, height: 5, overflow: "hidden" }}>
        <div style={{ width: `${(pos / session.total) * 100}%`, background: "#C99A3F", height: "100%", transition: "width 0.25s ease" }} />
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#1F3D3680" }}>
        <span>تثبيت {session.breakdown.known}</span>
        <span>·</span>
        <span>مراجعة {session.breakdown.review}</span>
        <span>·</span>
        <span>جديد {session.breakdown.new}</span>
      </div>
      <div style={{ color: "#1F3D3680", fontSize: 12 }} dir="ltr">{pos + 1} / {session.total}</div>
      {session.deferred > 0 && (
        <div style={{ color: "#A97A1E", fontSize: 11, marginTop: -12 }}>
          🕓 {session.deferred} لسه مستنية، هتظهر في مراجعة تانية عشان الكمية متبقاش كتير مرة واحدة
        </div>
      )}

      <WordReviewCard word={word} settings={settings} flipped={flipped} onFlip={() => setFlipped((f) => !f)} onGraded={handle} listenMode={listen} />
    </div>
  );
}

/* ---------------- Shared review card (flip / production recall) ----------------
   Used by both the daily Flashcards session and the standalone weak-words
   drill, so the flip/recall-mode logic lives in exactly one place. */
/** Blanks out the target word wherever it appears in an example sentence
   (whole-word, case-insensitive), so the front-face context clue on a
   recall-mode card can't be used to just read the spelling off before
   flipping - the bug this exists to fix. */
function maskWordInExample(example, word) {
  if (!example || !word) return example;
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return example;
  const re = new RegExp(`\\b${escaped}\\b`, "gi");
  return example.replace(re, "_____");
}

function WordReviewCard({ word, settings, flipped, onFlip, onGraded, listenMode = false }) {
  // Words already seen at least once (repetition > 0) get production recall
  // instead of simple recognition: meaning first, then type the word letter
  // by letter. A word you've never been shown yet has nothing to "recall"
  // the spelling of, so it keeps the classic flip-to-reveal-meaning card.
  //
  // Exception: words below your chosen level ("known" bucket - stuff
  // you've already mastered, only kept around for light upkeep) don't all
  // need full spelling recall every time - that's overkill for words you
  // clearly already have. Only a small, fixed sample of them get the
  // recall treatment; the rest keep the quicker flip. The sample is
  // decided per-word (via a stable hash of its id), not per-review, so a
  // given "known" word is consistently either a recall word or a flip
  // word rather than flickering between modes.
  const KNOWN_RECALL_SAMPLE_RATE = 0.2;
  const alreadySeen = (word.repetition || 0) > 0;
  const levelBucket = bucketOf(word, settings.level);
  const recallMode = alreadySeen && (levelBucket !== "known" || hashToUnit(word.id) < KNOWN_RECALL_SAMPLE_RATE);

  // Recall-mode words WITH an example sentence get cloze (type the whole
  // word into the blanked sentence, in context); ones without an example
  // fall back to letter-by-letter recall since there's no sentence to
  // build a cloze from.
  const hasExample = !!(word.example && word.example.trim());
  const useCloze = recallMode && hasExample;

  const handleCardClick = () => {
    if (recallMode && flipped) return; // don't flip back mid-typing by accident
    onFlip();
  };

  // Listening mode: the front face hides the written word entirely and
  // auto-plays its pronunciation instead - the person has to recognize it
  // by ear before flipping to check, rather than reading it. Only applies
  // to the plain recognition card (recall-mode cards already start from
  // the meaning, not the word, so there's nothing to hide there).
  useEffect(() => {
    if (listenMode && !recallMode && !flipped) speak(word.word, { accent: settings.accent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word.id, listenMode, flipped]);

  // Brief visual pulse right at the moment of grading, before advancing
  // to the next word - immediate tactile feedback ("satisfying") instead
  // of the grade only showing up indirectly later via bucket/streak state.
  const [pulse, setPulse] = useState(null); // { color, emoji } | null
  const PULSE_BY_QUALITY = {
    0: { color: "#c1785b", emoji: "✗" },
    3: { color: "#A97A1E", emoji: "~" },
    4: { color: "#5c8f7d", emoji: "✓" },
    5: { color: "#3a6b5c", emoji: "✓" },
  };
  const gradeWithPulse = (quality) => {
    setPulse(PULSE_BY_QUALITY[quality] || PULSE_BY_QUALITY[4]);
    setTimeout(() => { setPulse(null); onGraded(quality); }, 320);
  };

  return (
    <>
      <div style={{ perspective: 1000, width: "100%", maxWidth: 320, height: 210, position: "relative" }} onClick={handleCardClick}>
        <div key={word.id} className={`card-flip ${flipped ? "flipped" : ""}`} style={{ position: "relative", width: "100%", height: "100%", cursor: "pointer" }}>
          <div className="card-face" style={{ ...cardFaceStyle, background: "#FFFFFF" }}>
            <div style={{ position: "absolute", top: 10, right: 14, display: "flex", gap: 6 }}>
              <span style={{ fontSize: 10, background: "#16302B12", color: "#16302B99", padding: "2px 8px", borderRadius: 20 }}>{word.category}</span>
              {word.level && <span style={{ fontSize: 10, background: "#C99A3F22", color: "#8a6a1f", padding: "2px 8px", borderRadius: 20 }}>{word.level}</span>}
            </div>
            {recallMode ? (
              <>
                <span style={{ fontSize: 22, fontWeight: 700, color: "#16302B", textAlign: "center" }}>{word.meaning}</span>
                {word.example && !useCloze && (
                  <div style={{ fontSize: 12, color: "#16302B80", marginTop: 10, fontStyle: "italic", textAlign: "center" }}>
                    {maskWordInExample(word.example, word.word)}
                  </div>
                )}
                <div style={{ position: "absolute", bottom: 12, fontSize: 11, color: "#16302B60" }}>
                  {useCloze ? "اضغط واكمل الجملة" : "اضغط واكتب الكلمة الإنجليزية"}
                </div>
              </>
            ) : listenMode ? (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); speak(word.word, { accent: settings.accent }); }}
                  style={{ background: "#16302B10", border: "none", borderRadius: "50%", width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <Volume2 size={30} color="#16302B" />
                </button>
                <div style={{ position: "absolute", bottom: 12, fontSize: 11, color: "#16302B60" }}>اسمع وحاول تفتكر المعنى، اضغط لتشوف</div>
              </>
            ) : (
              <>
                <span className="eng" style={{ fontSize: 26, fontWeight: 700, color: "#16302B" }}>{word.word}</span>
                <div style={{ marginTop: 10 }}>
                  <SpeakButton word={word.word} withLabel color="#16302B" accent={settings.accent} />
                </div>
                <div style={{ position: "absolute", bottom: 12, fontSize: 11, color: "#16302B60" }}>اضغط لعرض المعنى</div>
              </>
            )}
          </div>
          <div className="card-face back" style={{ ...cardFaceStyle, background: "#3a6b5c" }}>
            {recallMode ? (
              useCloze ? (
                <ClozeCard key={word.id} sentence={word.example} word={word.word} onGraded={gradeWithPulse} />
              ) : (
                <MissingLetterCard key={word.id} word={word.word} onGraded={gradeWithPulse} />
              )
            ) : (
              <>
                <span style={{ fontSize: 20, fontWeight: 700, color: "#FFFFFF" }}>{word.meaning}</span>
                {word.example && <div style={{ fontSize: 12, color: "#FFFFFFcc", marginTop: 10, fontStyle: "italic", textAlign: "center" }}>{word.example}</div>}
              </>
            )}
          </div>
        </div>
        {pulse && (
          <div
            style={{
              position: "absolute", inset: 0, borderRadius: 16, pointerEvents: "none",
              background: `${pulse.color}22`, border: `3px solid ${pulse.color}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 52, color: pulse.color, fontWeight: 700, animation: "pulseIn 0.32s ease-out",
            }}
          >
            {pulse.emoji}
          </div>
        )}
      </div>

      {flipped && !recallMode && (
        <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 320 }}>
          <ReviewBtn label="غلط" color="#c1785b" onClick={() => gradeWithPulse(0)} icon={<RotateCcw size={14} />} />
          <ReviewBtn label="صعبة" color="#c99a3f" onClick={() => gradeWithPulse(3)} />
          <ReviewBtn label="جيدة" color="#5c8f7d" onClick={() => gradeWithPulse(4)} />
          <ReviewBtn label="سهلة" color="#3a6b5c" onClick={() => gradeWithPulse(5)} />
        </div>
      )}
    </>
  );
}

/* ---------------- Filtered word drill (weak words / leeches) ----------------
   Unlike the daily Flashcards session (gated by nextReview date and the
   daily caps), this pulls every word matching a given predicate
   regardless of when it's next due - the whole point is letting the
   person proactively drill a specific problem set whenever they want,
   not wait for the schedule. Shared by the Weak-words screen and the
   Leeches screen so the drill flow itself isn't duplicated. */
function FilteredWordsScreen({ locked = false, onUnlock, words, situations = [], settings, onReview, onDelete, onToggleSuspend, onToggleFavorite, accent, goTab, filterFn, title, emptyTitle, emptyBody, activeBody, drillLabel, accentColor }) {
  const [reviewing, setReviewing] = useState(false);
  const matched = words.filter(filterFn);
  const situationFor = (word) =>
    situations.find((s) => s.targetWord && s.targetWord.trim().toLowerCase() === word.word.trim().toLowerCase());

  useBackClose(() => setReviewing(false), reviewing);

  if (reviewing && locked) {
    return <LockedScreen kind="words" onUnlock={onUnlock} onBack={() => setReviewing(false)} />;
  }
  if (reviewing) {
    return <FilteredWordsDrill words={matched} settings={settings} onReview={onReview} onExit={() => setReviewing(false)} emptyMessage={emptyTitle} doneMessage={`خلصت ${title} 💪`} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <button onClick={() => goTab("dashboard")} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#1F3D3680", cursor: "pointer", fontSize: 13, padding: 0 }}>‹ لوحتي</button>
      <div style={{ background: matched.length ? accentColor : "#DFE8E2", borderRadius: 16, padding: 20, border: "1px dashed #9DB5A8" }}>
        <div className="display" style={{ color: "#1F3D36", fontSize: 18, fontWeight: 700 }}>
          {matched.length > 0 ? `عندك ${matched.length} ${title}` : emptyTitle}
        </div>
        <div style={{ color: matched.length ? "#FBF6EAcc" : "#1F3D3699", fontSize: 13, marginTop: 4 }}>
          {matched.length > 0 ? activeBody : emptyBody}
        </div>
      </div>
      {matched.length > 0 && (
        <button onClick={() => setReviewing(true)} style={primaryBtnStyle}>{locked ? "🔒 " : ""}{drillLabel}</button>
      )}
      {matched.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {matched.map((w) => {
            const related = situationFor(w);
            return (
              <div key={w.id}>
                <WordCard w={w} onDelete={onDelete} onToggleSuspend={onToggleSuspend} onToggleFavorite={onToggleFavorite} accent={accent} />
                {related && (
                  <button
                    onClick={() => goTab("situations")}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, background: "#E9EFE9", border: "none", padding: "8px 14px", marginTop: -6, borderRadius: "0 0 10px 10px", color: "#1F3D36cc", fontSize: 12, cursor: "pointer", textAlign: "right" }}
                  >
                    <Link2 size={12} color="#A97A1E" />
                    <span style={{ flex: 1 }} className="eng">جرّب في موقف: {related.phrase}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilteredWordsDrill({ words, settings, onReview, onExit, emptyMessage, doneMessage }) {
  const [pool] = useState(() => shuffle(words));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);

  if (pool.length === 0 || pos >= pool.length) {
    return (
      <div style={{ textAlign: "center", color: "#1F3D3680", padding: "60px 20px" }}>
        <Check size={40} color="#3a6b5c" style={{ marginBottom: 10 }} />
        <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>{pool.length === 0 ? emptyMessage : doneMessage}</div>
        <button onClick={onExit} style={{ marginTop: 16, ...primaryBtnStyle, display: "inline-flex", padding: "10px 20px" }}>رجوع</button>
      </div>
    );
  }

  const word = pool[pos];
  const handle = (quality) => { onReview(word.id, quality); setFlipped(false); setPos((p) => p + 1); };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, paddingTop: 10 }}>
      <button onClick={onExit} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#1F3D3680", cursor: "pointer", fontSize: 13 }}>‹ رجوع</button>
      <div style={{ color: "#1F3D3680", fontSize: 12 }} dir="ltr">{pos + 1} / {pool.length}</div>
      <WordReviewCard word={word} settings={settings} flipped={flipped} onFlip={() => setFlipped((f) => !f)} onGraded={handle} />
    </div>
  );
}

function WeakWordsScreen(props) {
  return (
    <FilteredWordsScreen
      {...props}
      filterFn={(w) => w.bucket === "Weak"}
      title="كلمة ضعيفة"
      emptyTitle="مفيش كلمات ضعيفة دلوقتي 🎉"
      emptyBody="كل الكلمات اللي غلطت فيها اتحسّنت، استمر كده!"
      activeBody="دي كلمات قلت إنك مش عارفها أو غلطت فيها - تستاهل مراجعة إضافية. بترجع للمراجعة العادية بعد 3 إجابات صح ورا بعض"
      drillLabel="ابدأ مراجعة الكلمات الضعيفة"
      accentColor="#c1785b"
    />
  );
}

function LeechesScreen(props) {
  const leechIds = new Set(findLeeches(props.words).map((w) => w.id));
  return (
    <FilteredWordsScreen
      {...props}
      filterFn={(w) => leechIds.has(w.id)}
      title="كلمة عالقة"
      emptyTitle="مفيش كلمات عالقة دلوقتي 🎉"
      emptyBody={`مفيش كلمة فشلت فيها ${LEECH_THRESHOLD} مرات أو أكتر - ده مؤشر كويس جدًا`}
      activeBody={`دي كلمات فشلت فيها ${LEECH_THRESHOLD} مرات أو أكتر إجمالًا - تستاهل أسلوب مذاكرة مختلف (جملة تانية، ربطها بكلمة تانية) مش بس تكرار عادي`}
      drillLabel="ابدأ مراجعة الكلمات العالقة"
      accentColor="#8a5a3f"
    />
  );
}

/* ---------------- Statistics ---------------- */
function Statistics({ data, goTab }) {
  const stats = computeStatistics(data.words, data.streak);
  const heatmap = computeActivityHeatmap(data.words, 35);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <button onClick={() => goTab("dashboard")} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#1F3D3680", cursor: "pointer", fontSize: 13, padding: 0 }}>‹ لوحتي</button>
      <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>إحصائياتك</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatCard label="إجمالي المراجعات" value={stats.totalReviews} />
        <StatCard label="نسبة الصح" value={`${stats.accuracy}%`} />
        <StatCard label="مراجعات النهاردة" value={stats.todayReviews} />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <StatCard label="كلمات ضعيفة" value={stats.weakCount} />
        <StatCard label="كلمات متقنة" value={stats.masteredCount} />
        <StatCard label="أيام متتالية" value={stats.streakCount} />
      </div>

      <ActivityHeatmap days={heatmap} />

      {stats.hardestWords.length > 0 && (
        <div>
          <div className="display" style={{ color: "#1F3D36", fontSize: 15, marginBottom: 8 }}>أصعب الكلمات عليك</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stats.hardestWords.map((w) => (
              <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#E9EFE9", borderRadius: 10, padding: "10px 14px", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <span className="eng" style={{ color: "#1F3D36", fontWeight: 700 }}>{w.word}</span>
                  <span style={{ color: "#1F3D3680", fontSize: 12, marginRight: 8 }}>{w.meaning}</span>
                </div>
                <span style={{ color: "#c1785b", fontSize: 12, whiteSpace: "nowrap" }}>غلطت {w.failureCount || 0} مرة</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stats.totalReviews === 0 && (
        <div style={{ color: "#1F3D3699", fontSize: 13, textAlign: "center", marginTop: 20 }}>ابدأ تراجع كلمات عشان تبان إحصائياتك هنا.</div>
      )}
    </div>
  );
}

/* Github-style activity grid: last 35 days, 5 columns of 7 (Sat->Fri per
   column, oldest column first) with intensity buckets by review count. */
function ActivityHeatmap({ days }) {
  const colorFor = (count) => {
    if (count === 0) return "#1F3D3610";
    if (count <= 2) return "#3a6b5c55";
    if (count <= 5) return "#3a6b5c99";
    if (count <= 10) return "#3a6b5cdd";
    return "#2f9e75";
  };
  const columns = [];
  for (let i = 0; i < days.length; i += 7) columns.push(days.slice(i, i + 7));

  return (
    <div>
      <div className="display" style={{ color: "#1F3D36", fontSize: 15, marginBottom: 8 }}>نشاطك آخر 5 أسابيع</div>
      <div style={{ display: "flex", gap: 4, justifyContent: "flex-start" }}>
        {columns.map((col, ci) => (
          <div key={ci} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {col.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.count} مراجعة`}
                style={{ width: 14, height: 14, borderRadius: 3, background: colorFor(d.count) }}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 10, color: "#1F3D3699" }}>
        <span>أقل</span>
        {[0, 1, 3, 7, 12].map((c) => <div key={c} style={{ width: 10, height: 10, borderRadius: 2, background: colorFor(c) }} />)}
        <span>أكتر</span>
      </div>
    </div>
  );
}

const cardFaceStyle = { position: "absolute", inset: 0, borderRadius: 16, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, boxShadow: "0 8px 24px rgba(0,0,0,.25)" };

function ReviewBtn({ label, color, onClick, icon }) {
  return (
    <button onClick={onClick} style={{ flex: 1, background: color, border: "none", borderRadius: 10, padding: "10px 4px", color: "#fff", fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      {icon}{label}
    </button>
  );
}

/* ---------------- Missing-letter recall ----------------
   Roughly REVEAL_RATIO of the word's letters are shown as hints (the
   first letter is always one of them, as an anchor), the rest - however
   many that is, however long the word - become input boxes. Spaces and
   punctuation always stay visible as-is; they're not part of the recall.
   Typing a letter auto-advances to the next box; Backspace on an empty
   box steps back. Once the last box is filled it grades itself
   automatically - no manual "check" click needed - and maps accuracy to
   the same quality scale the flip cards use:
     all letters correct      -> quality 5 ("سهلة")
     at least half correct    -> quality 3 ("صعبة")
     under half correct       -> quality 0 ("غلط")
   The correct spelling is then revealed (green = correct, red = wrong)
   before moving on, so a wrong guess still teaches the right answer. */
const REVEAL_RATIO = 0.3;

function MissingLetterCard({ word, onGraded }) {
  const chars = word.split("");
  const alphaIndices = chars.map((c, i) => (/[a-zA-Z]/.test(c) ? i : null)).filter((i) => i !== null);

  // Recomputed fresh each time this component mounts (it's keyed by
  // word.id, so a new word - or the same word shown again another day -
  // gets its own random pick of which letters to reveal).
  const [revealSet] = useState(() => {
    const revealCount = Math.max(1, Math.round(alphaIndices.length * REVEAL_RATIO));
    const set = new Set(alphaIndices.length ? [alphaIndices[0]] : []); // first letter always shown as an anchor
    const pool = alphaIndices.slice(1).sort(() => Math.random() - 0.5);
    for (let i = 0; set.size < revealCount && i < pool.length; i++) set.add(pool[i]);
    return set;
  });
  const isBlank = (c, i) => /[a-zA-Z]/.test(c) && !revealSet.has(i);
  const blankIndices = chars.map((c, i) => (isBlank(c, i) ? i : null)).filter((i) => i !== null);

  const [values, setValues] = useState(() => chars.map((c, i) => (isBlank(c, i) ? "" : c)));
  const [graded, setGraded] = useState(null); // { quality, label, color }
  const inputRefs = useRef([]);

  useEffect(() => {
    inputRefs.current[blankIndices[0]]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grade = (finalValues) => {
    if (blankIndices.length === 0) { // e.g. a 1-letter word - nothing to type, treat as easy
      setGraded({ quality: 5, label: "سهلة", color: "#3a6b5c" });
      return;
    }
    const correct = blankIndices.filter((i) => (finalValues[i] || "").toLowerCase() === chars[i].toLowerCase()).length;
    const ratio = correct / blankIndices.length;
    if (ratio === 1) setGraded({ quality: 5, label: "سهلة", color: "#3a6b5c" });
    else if (ratio >= 0.5) setGraded({ quality: 3, label: "صعبة", color: "#A97A1E" });
    else setGraded({ quality: 0, label: "غلط", color: "#c1785b" });
  };

  const handleChange = (i, raw) => {
    if (graded) return;
    const letter = raw.replace(/[^a-zA-Z]/g, "").slice(-1);
    const next = [...values];
    next[i] = letter;
    setValues(next);
    if (!letter) return;
    const idxInList = blankIndices.indexOf(i);
    if (idxInList < blankIndices.length - 1) {
      inputRefs.current[blankIndices[idxInList + 1]]?.focus();
    } else {
      grade(next);
    }
  };

  const handleKeyDown = (i, e) => {
    if (e.key === "Backspace" && !values[i]) {
      const idxInList = blankIndices.indexOf(i);
      if (idxInList > 0) inputRefs.current[blankIndices[idxInList - 1]]?.focus();
    }
  };

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", direction: "ltr" }}>
        {chars.map((c, i) =>
          isBlank(c, i) ? (
            <input
              key={i}
              ref={(el) => (inputRefs.current[i] = el)}
              value={graded ? chars[i] : values[i] || ""}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              disabled={!!graded}
              maxLength={1}
              inputMode="text"
              autoComplete="off"
              className="eng"
              style={{
                width: 26, height: 32, textAlign: "center", fontSize: 16, fontWeight: 700,
                borderRadius: 6, border: "none",
                background: graded ? ((values[i] || "").toLowerCase() === c.toLowerCase() ? "#5c8f7d" : "#c1785b") : "#FBF6EA",
                color: graded ? "#FBF6EA" : "#16302B",
              }}
            />
          ) : c === " " ? (
            <span key={i} style={{ width: 12 }} />
          ) : (
            <span key={i} className="eng" style={{ width: 26, height: 32, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "#FFFFFF" }}>{c}</span>
          )
        )}
      </div>
      {graded && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: graded.color }}>● {graded.label}</span>
          <button onClick={() => onGraded(graded.quality)} style={{ ...primaryBtnStyle, padding: "8px 24px" }}>التالي</button>
        </div>
      )}
    </div>
  );
}

/** Small edit-distance helper, just for cloze grading below - not exact
 * matching only, so a one-letter typo doesn't get graded the same as a
 * completely wrong guess. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/* ---------------- Cloze recall ----------------
   Instead of typing the word letter by letter in isolation, the word's
   own example sentence is shown with the word blanked out and one input
   in its place - production recall *in context*, which is closer to how
   the word actually gets used than an isolated spelling drill. Grading
   is by edit distance rather than exact-match-only, so a small typo
   ("improov") still counts as "close" rather than flat wrong:
     exact match (case-insensitive)      -> quality 5 ("سهلة")
     small typo (edit distance small)    -> quality 3 ("قريبة")
     otherwise                           -> quality 0 ("غلط") */
function ClozeCard({ sentence, word, onGraded }) {
  const [value, setValue] = useState("");
  const [graded, setGraded] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const grade = () => {
    const typed = value.trim().toLowerCase();
    const target = word.trim().toLowerCase();
    if (!typed) { setGraded({ quality: 0, label: "غلط", color: "#c1785b" }); return; }
    if (typed === target) { setGraded({ quality: 5, label: "سهلة", color: "#3a6b5c" }); return; }
    const dist = levenshtein(typed, target);
    const closeEnough = dist <= 1 || dist <= Math.ceil(target.length * 0.25);
    setGraded(closeEnough ? { quality: 3, label: "قريبة", color: "#A97A1E" } : { quality: 0, label: "غلط", color: "#c1785b" });
  };

  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = sentence.split(new RegExp(`\\b${escaped}\\b`, "i"));

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "0 14px" }}>
      <div className="eng" style={{ fontSize: 15, color: "#FFFFFF", textAlign: "center", lineHeight: 1.8, direction: "ltr" }}>
        {parts.length > 1 ? (
          <>
            {parts[0]}
            <input
              ref={inputRef}
              value={graded ? word : value}
              onChange={(e) => !graded && setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !graded) grade(); }}
              disabled={!!graded}
              autoComplete="off"
              className="eng"
              style={{
                width: Math.max(60, word.length * 11), textAlign: "center", fontSize: 15, fontWeight: 700,
                borderRadius: 6, border: "none", margin: "0 4px", padding: "2px 4px",
                background: graded ? (graded.quality === 5 ? "#5c8f7d" : graded.quality === 3 ? "#c99a3f" : "#c1785b") : "#FBF6EA",
                color: graded ? "#FBF6EA" : "#16302B",
              }}
            />
            {parts.slice(1).join(word)}
          </>
        ) : (
          sentence // fallback: word not found in sentence as a whole word, just show it plain (shouldn't normally happen)
        )}
      </div>
      {!graded && (
        <button onClick={grade} style={{ ...primaryBtnStyle, padding: "8px 24px" }}>تحقق</button>
      )}
      {graded && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: graded.color }}>
            ● {graded.label}{graded.quality !== 5 && ` (الصح: ${word})`}
          </span>
          <button onClick={() => onGraded(graded.quality)} style={{ ...primaryBtnStyle, padding: "8px 24px" }}>التالي</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Add Word / CSV Import ---------------- */
/* ---------------- CSV import preview ----------------
   Shared by AddWord and AddSituation: after parsing (via CSVService),
   shows each row's status - new / duplicate / missing required fields -
   before anything actually gets added, with an option to skip duplicates
   automatically. Only a capped number of rows render in the list itself
   (large imports would otherwise dump hundreds of DOM rows), but the
   counts and the actual import always reflect the full parsed set. */
const CSV_PREVIEW_LIMIT = 50;

function CSVPreview({ rows, columns, itemLabel, onConfirm, onBack }) {
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const validRows = rows.filter((r) => r.__valid);
  const duplicateCount = validRows.filter((r) => r.__duplicate).length;
  const invalidCount = rows.length - validRows.length;
  const toImport = validRows.filter((r) => !(skipDuplicates && r.__duplicate));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ background: "#5c8f7d33", color: "#5c8f7d", padding: "4px 10px", borderRadius: 20 }}>{validRows.length} صالحة</span>
        {duplicateCount > 0 && <span style={{ background: "#c99a3f33", color: "#A97A1E", padding: "4px 10px", borderRadius: 20 }}>{duplicateCount} مكررة</span>}
        {invalidCount > 0 && <span style={{ background: "#c1785b33", color: "#c1785b", padding: "4px 10px", borderRadius: 20 }}>{invalidCount} ناقصة بيانات</span>}
      </div>

      {duplicateCount > 0 && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#1F3D36cc", cursor: "pointer" }}>
          <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
          تجاهل الصفوف المكررة تلقائيًا (موجودة عندك بالفعل أو متكررة في الملف نفسه)
        </label>
      )}

      <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.slice(0, CSV_PREVIEW_LIMIT).map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "#E9EFE9", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
              {columns.map((c) => (
                <span key={c.key} className={c.eng ? "eng" : undefined} style={{ fontSize: 12, color: "#1F3D36cc", marginLeft: 10 }}>
                  {r[c.key] || "—"}
                </span>
              ))}
            </div>
            <span style={{ fontSize: 10, whiteSpace: "nowrap", color: !r.__valid ? "#c1785b" : r.__duplicate ? "#c99a3f" : "#5c8f7d" }}>
              {!r.__valid ? "ناقصة" : r.__duplicate ? "مكررة" : "جديدة"}
            </span>
          </div>
        ))}
        {rows.length > CSV_PREVIEW_LIMIT && (
          <div style={{ textAlign: "center", color: "#1F3D3699", fontSize: 12, padding: "4px 0" }}>و {rows.length - CSV_PREVIEW_LIMIT} صف كمان...</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={onBack} style={{ ...primaryBtnStyle, flex: 1, background: "#E9EFE9", color: "#1F3D36" }}>رجوع للتعديل</button>
        <button
          type="button"
          onClick={() => onConfirm(toImport)}
          disabled={toImport.length === 0}
          style={{ ...primaryBtnStyle, flex: 2, opacity: toImport.length ? 1 : 0.5 }}
        >
          استيراد {toImport.length} {itemLabel}
        </button>
      </div>
    </div>
  );
}

function AddWord({ onAdd, onBulkAdd, onDone, existingWords }) {
  const [mode, setMode] = useState("single");
  const [form, setForm] = useState({ word: "", meaning: "", example: "", category: "", level: "" });
  const [csvText, setCsvText] = useState("word,meaning,example,category,level\napple,تفاحة,I ate an apple,أكل,A1\n");
  const [fileName, setFileName] = useState(null);
  const [previewRows, setPreviewRows] = useState(null);
  const csvFileRef = useRef(null);

  const submitSingle = (e) => {
    e.preventDefault();
    if (!form.word.trim() || !form.meaning.trim()) return;
    onAdd(form);
    onDone(`تمت إضافة "${form.word}"`);
    setForm({ word: "", meaning: "", example: "", category: "", level: "" });
  };

  const handleCSVFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result)); setFileName(file.name); };
    reader.onerror = () => setFileName(null);
    reader.readAsText(file);
    e.target.value = "";
  };

  const showPreview = () => {
    const rows = analyzeWordRows(parseWordsCSV(csvText), existingWords);
    setPreviewRows(rows);
  };

  const confirmImport = (rows) => {
    const count = onBulkAdd(rows);
    onDone(`تمت إضافة ${count} كلمة`);
  };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <BannerAdSlot placement="add" />
      </div>
      <div style={{ display: "flex", background: "#E9EFE9", borderRadius: 10, padding: 4, marginBottom: 16 }}>
        <TabBtn active={mode === "single"} onClick={() => { setMode("single"); setPreviewRows(null); }} label="كلمة واحدة" />
        <TabBtn active={mode === "csv"} onClick={() => setMode("csv")} label="استيراد CSV" />
      </div>

      {mode === "single" ? (
        <form onSubmit={submitSingle} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="الكلمة (إنجليزي)" value={form.word} onChange={(v) => setForm({ ...form, word: v })} eng required />
          <Field label="المعنى" value={form.meaning} onChange={(v) => setForm({ ...form, meaning: v })} required />
          <Field label="جملة مثال (اختياري)" value={form.example} onChange={(v) => setForm({ ...form, example: v })} eng />
          <Field label="التصنيف (اختياري)" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ color: "#1F3D3699", fontSize: 12 }}>المستوى (اختياري)</span>
            <select
              value={form.level}
              onChange={(e) => setForm({ ...form, level: e.target.value })}
              style={{ background: "#FFFFFF", border: "none", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "#16302B" }}
            >
              <option value="">بدون تحديد</option>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <button type="submit" style={primaryBtnStyle}>
            <Plus size={16} /> إضافة الكلمة
          </button>
        </form>
      ) : previewRows ? (
        <CSVPreview
          rows={previewRows}
          columns={[{ key: "word", eng: true }, { key: "meaning" }, { key: "level" }]}
          itemLabel="كلمة"
          onBack={() => setPreviewRows(null)}
          onConfirm={confirmImport}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ color: "#1F3D3699", fontSize: 12, lineHeight: 1.6 }}>
            اختار ملف CSV من جهازك، أو الصق البيانات يدويًا تحت. الأعمدة: word, meaning, example, category, level (كلهم اختياريين إلا word و meaning). المستوى يقبل A1, A2, B1, B2, C1, C2.
          </div>
          <button type="button" onClick={() => csvFileRef.current?.click()} style={{ ...iconBtnStyle, justifyContent: "center", color: "#1F3D36", padding: "12px 0" }}>
            <Upload size={16} color="#1F3D36" style={{ marginLeft: 6 }} /> {fileName ? `الملف: ${fileName}` : "اختيار ملف CSV"}
          </button>
          <input ref={csvFileRef} type="file" accept=".csv,text/csv" onChange={handleCSVFile} style={{ display: "none" }} />
          <textarea
            value={csvText}
            onChange={(e) => { setCsvText(e.target.value); setFileName(null); }}
            rows={8}
            className="eng"
            style={{ background: "#FFFFFF", borderRadius: 10, border: "none", padding: 12, fontSize: 13, resize: "vertical", direction: "ltr", boxSizing: "border-box", width: "100%" }}
          />
          <button onClick={showPreview} style={primaryBtnStyle}>
            <Search size={16} /> معاينة قبل الاستيراد
          </button>
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button onClick={onClick} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", cursor: "pointer", background: active ? "#C99A3F" : "transparent", color: active ? "#16302B" : "#1F3D3699", fontSize: 13, fontWeight: active ? 700 : 400 }}>
      {label}
    </button>
  );
}

function Field({ label, value, onChange, eng, required }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ color: "#1F3D3699", fontSize: 12 }}>{label}</span>
      <input
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className={eng ? "eng" : ""}
        dir={eng ? "ltr" : "rtl"}
        style={{ background: "#FFFFFF", border: "none", borderRadius: 10, padding: "10px 12px", fontSize: 14, color: "#16302B" }}
      />
    </label>
  );
}

const primaryBtnStyle = { background: "#C99A3F", border: "none", borderRadius: 10, padding: "12px 0", color: "#16302B", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 };

/* ---------------- Situations (separate content from the vocabulary dictionary) ----------------
   Real-life scenario phrases (supermarket, work, restaurant...) grouped by
   situation and tagged by level. Completely separate data (data.situations)
   from the word dictionary (data.words) - importing/editing one never
   touches the other. Reuses the same SM-2 fields and pronunciation
   service, but its own review session, independent of the vocabulary
   flashcards. Starter content itself now lives in src/data/ (see
   STARTER_SITUATIONS import at the top of this file), so this comment
   block is just orientation, not the data anymore. */

function Situations({ situations, onAdd, onBulkAdd, onDelete, onReview, accent, settings, firstSessionPending, onFirstSessionConsumed, locked = false, unlockKey, onSessionComplete, onUnlock }) {
  const [mode, setMode] = useState("browse"); // browse | add | csv | review
  useBackClose(() => setMode("browse"), mode !== "browse");
  const groups = {};
  situations.forEach((s) => {
    const cat = s.situation || "عام";
    (groups[cat] = groups[cat] || []).push(s);
  });
  const categoryNames = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const [expanded, setExpanded] = useState({});
  const toggle = (cat) => setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  // Capped like the words session: a big CSV import won't dump everything
  // into one sitting, it trickles in the same way. Reflects the one-time
  // small first-session cap too, so the badge count on the button matches
  // what the review session will actually show.
  const session = firstSessionPending ? buildQuickSituationSession(situations, settings, 3) : buildSituationSession(situations, settings);
  const due = { length: session.total };

  if (mode === "review") {
    return (
      <SituationFlashcards
        key={unlockKey || "none"}
        locked={locked}
        onUnlock={onUnlock}
        onSessionComplete={onSessionComplete}
        situations={situations}
        settings={settings}
        onReview={onReview}
        onExit={() => setMode("browse")}
        accent={accent}
        firstSessionPending={firstSessionPending}
        onFirstSessionConsumed={onFirstSessionConsumed}
      />
    );
  }
  if (mode === "add" || mode === "csv") {
    return <AddSituation initialMode={mode} onAdd={onAdd} onBulkAdd={onBulkAdd} existingSituations={situations} onDone={() => setMode("browse")} onCancel={() => setMode("browse")} />;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={() => setMode("review")} disabled={due.length === 0} style={{ ...primaryBtnStyle, flex: 1, opacity: due.length ? 1 : 0.5 }}>
          {locked ? "🔒 " : ""}مراجعة المواقف {due.length > 0 ? `(${due.length})` : ""}
        </button>
        <button onClick={() => setMode("add")} style={iconBtnStyle}><Plus size={16} color="#1F3D36" /></button>
        <button onClick={() => setMode("csv")} style={iconBtnStyle}><Upload size={16} color="#1F3D36" /></button>
        {situations.length > 0 && (
          <button onClick={() => downloadCSV(exportSituationsCSV(situations), "my-situations.csv")} title="تصدير CSV" style={iconBtnStyle}>
            <Download size={16} color="#1F3D36" />
          </button>
        )}
      </div>

      {situations.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 16px" }}>
          <div style={{ color: "#1F3D3680", fontSize: 13, marginBottom: 14, lineHeight: 1.7 }}>
            مفيش مواقف لسه. دي جمل حقيقية لمواقف يومية (مقابلة شغل، مطعم، سوبر ماركت، سفر...) بدل كلمات لوحدها.
          </div>
          <button
            onClick={() => onBulkAdd(STARTER_SITUATIONS)}
            style={{ ...primaryBtnStyle, display: "inline-flex", padding: "10px 20px" }}
          >
            أضف {STARTER_SITUATIONS.length} موقف جاهز
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {categoryNames.map((cat) => {
            const isOpen = !!expanded[cat];
            return (
              <div key={cat} style={{ background: "#E9EFE9", borderRadius: 12, overflow: "hidden" }}>
                <button
                  onClick={() => toggle(cat)}
                  style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: "12px 14px", cursor: "pointer" }}
                >
                  <span style={{ color: "#1F3D36", fontSize: 14, fontWeight: 700 }}>{cat}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#1F3D3680", fontSize: 12 }}>{groups[cat].length}</span>
                    {isOpen ? <ChevronDown size={16} color="#1F3D3680" /> : <ChevronLeft size={16} color="#1F3D3680" />}
                  </div>
                </button>
                {isOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 10px 10px" }}>
                    {groups[cat]
                      .sort((a, b) => levelIndex(a.level) - levelIndex(b.level))
                      .map((s) => (
                        <div key={s.id} style={{ background: "#FFFFFF", borderRadius: 12, padding: "12px 14px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <PhraseText phrase={s.phrase} targetWord={s.targetWord} style={{ fontSize: 15, fontWeight: 700, color: "#16302B" }} />
                                <SpeakButton word={s.phrase} accent={accent} title="سماع الجملة كاملة" />
                                {s.targetWord && <SpeakButton word={s.targetWord} accent={accent} color="#A97A1E" title="سماع الكلمة المستهدفة بس" />}
                              </div>
                              <div style={{ color: "#4a4038", fontSize: 13, marginTop: 2 }}>{s.meaning}</div>
                            </div>
                            <button onClick={() => onDelete(s.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                              <Trash2 size={15} color="#c1785b" />
                            </button>
                          </div>
                          {s.level && (
                            <span style={{ fontSize: 10, background: "#C99A3F22", color: "#8a6a1f", padding: "2px 8px", borderRadius: 20, marginTop: 6, display: "inline-block" }}>
                              {s.level}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SituationFlashcards({ situations, settings, onReview, onExit, accent, firstSessionPending, onFirstSessionConsumed, locked = false, onUnlock, onSessionComplete }) {
  const [session] = useState(() => (firstSessionPending ? buildQuickSituationSession(situations, settings, 3) : buildSituationSession(situations, settings)));
  useEffect(() => {
    if (firstSessionPending && onFirstSessionConsumed) onFirstSessionConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const map = Object.fromEntries(situations.map((s) => [s.id, s]));
  const [completedHere, setCompletedHere] = useState(false);
  useEffect(() => {
    if (session.total > 0 && pos >= session.total && !completedHere) {
      setCompletedHere(true);
      if (onSessionComplete) onSessionComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  if (locked && !completedHere) return <LockedScreen kind="situations" onUnlock={onUnlock} onBack={onExit} />;

  if (pos >= session.total) {
    return (
      <div style={{ textAlign: "center", color: "#1F3D3680", padding: "60px 20px" }}>
        <Check size={40} color="#3a6b5c" style={{ marginBottom: 10 }} />
        <div className="display" style={{ color: "#1F3D36", fontSize: 18 }}>خلصت مراجعة المواقف 🎉</div>
        {session.deferred > 0 && (
          <div style={{ fontSize: 12, marginTop: 6, color: "#A97A1E" }}>
            🕓 وفيه {session.deferred} موقف كمان مستنيين، هيجوا في مراجعة تانية.
          </div>
        )}
        <button onClick={onExit} style={{ marginTop: 16, ...primaryBtnStyle, display: "inline-flex", padding: "10px 20px" }}>رجوع</button>
      </div>
    );
  }

  const item = map[session.ids[pos]];
  const handle = (quality) => { onReview(item.id, quality); setFlipped(false); setPos((p) => p + 1); };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, paddingTop: 10 }}>
      <div style={{ color: "#1F3D3680", fontSize: 12 }} dir="ltr">{pos + 1} / {session.total}</div>
      {session.deferred > 0 && (
        <div style={{ color: "#A97A1E", fontSize: 11, marginTop: -12 }}>
          🕓 {session.deferred} لسه مستنيين، هيظهروا في مراجعة تانية
        </div>
      )}
      <div style={{ perspective: 1000, width: "100%", maxWidth: 320, height: 210 }} onClick={() => setFlipped((f) => !f)}>
        <div key={item.id} className={`card-flip ${flipped ? "flipped" : ""}`} style={{ position: "relative", width: "100%", height: "100%", cursor: "pointer" }}>
          <div className="card-face" style={{ ...cardFaceStyle, background: "#FFFFFF" }}>
            <div style={{ position: "absolute", top: 10, right: 14, display: "flex", gap: 6 }}>
              <span style={{ fontSize: 10, background: "#16302B12", color: "#16302B99", padding: "2px 8px", borderRadius: 20 }}>{item.situation}</span>
              {item.level && <span style={{ fontSize: 10, background: "#C99A3F22", color: "#8a6a1f", padding: "2px 8px", borderRadius: 20 }}>{item.level}</span>}
            </div>
            <PhraseText phrase={item.phrase} targetWord={item.targetWord} style={{ fontSize: 18, fontWeight: 700, color: "#16302B", textAlign: "center", padding: "0 10px" }} />
            <div style={{ marginTop: 10, display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
              <SpeakButton word={item.phrase} withLabel label="الجملة كاملة" color="#16302B" accent={accent} title="سماع الجملة كاملة" />
              {item.targetWord && (
                <SpeakButton word={item.targetWord} withLabel label="الكلمة بس" color="#8a6a1f" accent={accent} title="سماع الكلمة المستهدفة بس" />
              )}
            </div>
            <div style={{ position: "absolute", bottom: 12, fontSize: 11, color: "#16302B60" }}>اضغط لعرض المعنى</div>
          </div>
          <div className="card-face back" style={{ ...cardFaceStyle, background: "#3a6b5c" }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#FFFFFF", textAlign: "center", padding: "0 10px" }}>{item.meaning}</span>
          </div>
        </div>
      </div>
      {flipped && (
        <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 320 }}>
          <ReviewBtn label="غلط" color="#c1785b" onClick={() => handle(0)} icon={<RotateCcw size={14} />} />
          <ReviewBtn label="صعبة" color="#c99a3f" onClick={() => handle(3)} />
          <ReviewBtn label="جيدة" color="#5c8f7d" onClick={() => handle(4)} />
          <ReviewBtn label="سهلة" color="#3a6b5c" onClick={() => handle(5)} />
        </div>
      )}
    </div>
  );
}

function AddSituation({ initialMode, onAdd, onBulkAdd, onDone, onCancel, existingSituations }) {
  const [mode, setMode] = useState(initialMode === "csv" ? "csv" : "single");
  const [form, setForm] = useState({ situation: "", level: "", phrase: "", meaning: "", targetWord: "" });
  const [csvText, setCsvText] = useState("situation,level,phrase,meaning,targetWord\nrestaurant,A1,Can I see the menu please?,ممكن أشوف المنيو؟,menu\n");
  const [fileName, setFileName] = useState(null);
  const [previewRows, setPreviewRows] = useState(null);
  const csvFileRef = useRef(null);

  const handleCSVFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result)); setFileName(file.name); };
    reader.onerror = () => setFileName(null);
    reader.readAsText(file);
    e.target.value = "";
  };

  const submitSingle = (e) => {
    e.preventDefault();
    if (!form.phrase.trim() || !form.meaning.trim()) return;
    onAdd(form);
    onDone();
  };

  const showPreview = () => {
    const rows = analyzeSituationRows(parseSituationsCSV(csvText), existingSituations);
    setPreviewRows(rows);
  };

  const confirmImport = (rows) => {
    onBulkAdd(rows);
    onDone();
  };

  return (
    <div>
      <div style={{ display: "flex", background: "#E9EFE9", borderRadius: 10, padding: 4, marginBottom: 16 }}>
        <TabBtn active={mode === "single"} onClick={() => { setMode("single"); setPreviewRows(null); }} label="موقف واحد" />
        <TabBtn active={mode === "csv"} onClick={() => setMode("csv")} label="استيراد CSV" />
      </div>

      {mode === "single" ? (
        <form onSubmit={submitSingle} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="الموقف/الفئة (مثال: سوبر ماركت)" value={form.situation} onChange={(v) => setForm({ ...form, situation: v })} />
          <Field label="الجملة (إنجليزي)" value={form.phrase} onChange={(v) => setForm({ ...form, phrase: v })} eng required />
          <Field label="المعنى" value={form.meaning} onChange={(v) => setForm({ ...form, meaning: v })} required />
          <Field label="الكلمة المستهدفة (اختياري)" value={form.targetWord} onChange={(v) => setForm({ ...form, targetWord: v })} eng />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ color: "#1F3D3699", fontSize: 12 }}>المستوى (اختياري)</span>
            <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} style={selectStyle}>
              <option value="">بدون تحديد</option>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <button type="submit" style={primaryBtnStyle}><Plus size={16} /> إضافة الموقف</button>
          <button type="button" onClick={onCancel} style={{ ...primaryBtnStyle, background: "#E9EFE9", color: "#1F3D36" }}>إلغاء</button>
        </form>
      ) : previewRows ? (
        <CSVPreview
          rows={previewRows}
          columns={[{ key: "phrase", eng: true }, { key: "meaning" }, { key: "targetWord", eng: true }]}
          itemLabel="موقف"
          onBack={() => setPreviewRows(null)}
          onConfirm={confirmImport}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ color: "#1F3D3699", fontSize: 12, lineHeight: 1.6 }}>
            اختار ملف CSV من جهازك، أو الصق البيانات يدويًا تحت. الأعمدة: situation, level, phrase, meaning, targetWord (level و targetWord اختياريين، الباقي مطلوب).
          </div>
          <button type="button" onClick={() => csvFileRef.current?.click()} style={{ ...iconBtnStyle, justifyContent: "center", color: "#1F3D36", padding: "12px 0" }}>
            <Upload size={16} color="#1F3D36" style={{ marginLeft: 6 }} /> {fileName ? `الملف: ${fileName}` : "اختيار ملف CSV"}
          </button>
          <input ref={csvFileRef} type="file" accept=".csv,text/csv" onChange={handleCSVFile} style={{ display: "none" }} />
          <textarea
            value={csvText}
            onChange={(e) => { setCsvText(e.target.value); setFileName(null); }}
            rows={8}
            className="eng"
            style={{ background: "#FFFFFF", borderRadius: 10, border: "none", padding: 12, fontSize: 13, resize: "vertical", direction: "ltr", boxSizing: "border-box", width: "100%" }}
          />
          <button onClick={showPreview} style={primaryBtnStyle}><Search size={16} /> معاينة قبل الاستيراد</button>
          <button type="button" onClick={onCancel} style={{ ...primaryBtnStyle, background: "#E9EFE9", color: "#1F3D36" }}>إلغاء</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Bottom Nav ---------------- */
function BottomNav({ tab, setTab, wordsBadge, situationsBadge }) {
  const items = [
    { key: "dashboard",  label: "الرئيسية", icon: LayoutGrid,    badge: 0 },
    { key: "dictionary", label: "مفرداتي",  icon: BookOpen,      badge: 0 },
    { key: "flashcards", label: "البطاقات", icon: Layers,        badge: wordsBadge },
    { key: "situations", label: "مواقف",    icon: MessageSquare, badge: situationsBadge },
    { key: "add",        label: "إضافة",    icon: Plus,          badge: 0 },
  ];
  return (
    <nav style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex", background: "#FFFFFF", borderTop: "1px solid #E2E0D6", padding: "8px 6px calc(10px + env(safe-area-inset-bottom))" }}>
      {items.map(({ key, label, icon: Icon, badge }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-current={active ? "page" : undefined}
            style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "6px 0 8px", position: "relative", color: active ? "#1F6B4F" : "#5b6b65" }}
          >
            <Icon size={24} strokeWidth={active ? 2.2 : 1.8} />
            <span style={{ fontSize: 12, fontWeight: active ? 700 : 400 }}>{label}</span>
            {badge > 0 && (
              <span style={{ position: "absolute", top: 0, left: "calc(50% + 6px)", background: "#E5533D", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>
                {badge}
              </span>
            )}
            {active && <span style={{ position: "absolute", bottom: -2, width: 44, height: 3, borderRadius: 3, background: "#1F6B4F" }} />}
          </button>
        );
      })}
    </nav>
  );
}
