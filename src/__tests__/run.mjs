/**
 * حصيلتي — service-layer test suite
 * Run: node src/__tests__/run.mjs  (or: npm test)
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SVC = join(__dirname, "..", "services");
const DATA = join(__dirname, "..", "data");
const svc  = (n) => import(join(SVC,  n));
const data = (n) => import(join(DATA, n));

const todayStr = () => new Date().toISOString().slice(0, 10);
const now      = new Date().toISOString();

let suitesPassed = 0, suitesFailed = 0, totalPassed = 0, totalFailed = 0;

function suite(name, fn) {
  return async () => {
    const results = [];
    const check = (label, cond) => {
      results.push({ label, ok: !!cond });
      totalPassed += cond ? 1 : 0;
      totalFailed += cond ? 0 : 1;
    };
    await fn(check);
    const failed = results.filter((r) => !r.ok);
    const ok = failed.length === 0;
    ok ? suitesPassed++ : suitesFailed++;
    console.log(`  ${ok ? "✓" : "✗"} ${name} (${results.length - failed.length}/${results.length})`);
    failed.forEach((r) => console.log(`      ✗ ${r.label}`));
  };
}

const tests = [];

/* ---- SM2Engine ---- */
tests.push(suite("SM2Engine: quality-0 resets repetition", async (check) => {
  const { applySM2 } = await svc("SM2Engine.js");
  const r = applySM2({ ef: 2.5, repetition: 3, interval: 15 }, 0);
  check("repetition reset to 0",   r.repetition === 0);
  check("interval is 1",           r.interval   === 1);
  check("ef clamped ≥ 1.3",        r.ef         >= 1.3);
}));

tests.push(suite("SM2Engine: quality-5 advances correctly", async (check) => {
  const { applySM2 } = await svc("SM2Engine.js");
  const r1 = applySM2({ ef: 2.5, repetition: 0, interval: 0 }, 5);
  const r2 = applySM2({ ...r1 }, 5);
  const r3 = applySM2({ ...r2 }, 5);
  check("first interval = 1",   r1.interval === 1);
  check("second interval = 6",  r2.interval === 6);
  check("third interval > 6",   r3.interval > 6);
}));

tests.push(suite("SM2Engine: nextBucket state machine", async (check) => {
  const { nextBucket } = await svc("SM2Engine.js");
  check("Unknown+1correct → Review",       nextBucket("Unknown",  {correctStreak:1,wrongStreak:0}) === "Review");
  check("Review+1wrong → Weak",            nextBucket("Review",   {correctStreak:0,wrongStreak:1}) === "Weak");
  check("Unknown+1wrong → Weak",           nextBucket("Unknown",  {correctStreak:0,wrongStreak:1}) === "Weak");
  check("Learning+1wrong → Weak",          nextBucket("Learning", {correctStreak:0,wrongStreak:1}) === "Weak");
  check("Mastered+1wrong stays Mastered",  nextBucket("Mastered", {correctStreak:0,wrongStreak:1}) === "Mastered");
  check("Weak+1correct (< 3) → Weak",      nextBucket("Weak",     {correctStreak:1,wrongStreak:0}) === "Weak");
  check("Weak+3correct → Review",          nextBucket("Weak",     {correctStreak:3,wrongStreak:0}) === "Review");
  check("Mastered+2wrong → Weak",          nextBucket("Mastered", {correctStreak:0,wrongStreak:2}) === "Weak");
  check("Suspended never auto-changes",    nextBucket("Suspended",{correctStreak:9,wrongStreak:0}) === "Suspended");
  check("8 correct → Mastered",            nextBucket("Learning", {correctStreak:8,wrongStreak:0}) === "Mastered");
}));

tests.push(suite("SM2Engine: applyPerformanceTracking", async (check) => {
  const { applyPerformanceTracking } = await svc("SM2Engine.js");
  const base = { successCount:2, failureCount:1, consecutiveCorrect:2, consecutiveFailures:0, confidence:50, lapses:0, reviewHistory:[] };
  const c = applyPerformanceTracking(base, 4);
  check("correct: successCount++",             c.successCount === 3);
  check("correct: consecutiveFailures reset",  c.consecutiveFailures === 0);
  check("correct: confidence rises",           c.confidence > 50);
  const w = applyPerformanceTracking(base, 0);
  check("wrong: failureCount++",               w.failureCount === 2);
  check("wrong: consecutiveCorrect reset",     w.consecutiveCorrect === 0);
  check("wrong: confidence drops",             w.confidence < 50);
}));

/* ---- SchedulerService ---- */
tests.push(suite("Scheduler: Suspended words excluded", async (check) => {
  const { buildSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  // emptyWordExtras() first so explicit overrides win (bucket, level, etc.)
  const words = [
    { ...emptyWordExtras(), id:"sus", level:"B1", repetition:3, nextReview:"2020-01-01", bucket:"Suspended", createdAt:now },
    { ...emptyWordExtras(), id:"ok",  level:"B1", repetition:0, nextReview:todayStr(),  bucket:"Unknown",   createdAt:now },
  ];
  const s = buildSession(words, { ...DEFAULT_SETTINGS, level:"B1" });
  check("suspended excluded", !s.ids.includes("sus"));
  check("due word included",   s.ids.includes("ok"));
}));

tests.push(suite("Scheduler: 500-word import capped to dailySessionCap", async (check) => {
  const { buildSession, buildSituationSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY }  = await data("starterVocabulary.js");
  const { STARTER_SITUATIONS }  = await data("starterSituations.js");
  const settings = { ...DEFAULT_SETTINGS, level:"A2" };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const sits  = STARTER_SITUATIONS.map((s) => ({ id:Math.random().toString(36).slice(2), situation:s.situation, level:s.level, phrase:s.phrase, meaning:s.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const ws = buildSession(words, settings);
  const ss = buildSituationSession(sits, settings);
  check(`words ≤ dailySessionCap (got ${ws.total})`,     ws.total <= settings.dailySessionCap);
  check("deferred = total - shown",                         ws.deferred === words.length - ws.total);
  check(`sits ≤ dailySituationSessionCap (got ${ss.total})`, ss.total <= settings.dailySituationSessionCap);
}));

/* ---- First session caps — all 4 levels (8 required tests) ---- */
tests.push(suite("First session: ≤10 words / ≤3 situations / same level — A1", async (check) => {
  const { buildQuickSession, buildQuickSituationSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const { STARTER_SITUATIONS } = await data("starterSituations.js");
  const level = "A1";
  const settings = { ...DEFAULT_SETTINGS, level };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const sits  = STARTER_SITUATIONS.map((s) => ({ id:Math.random().toString(36).slice(2), situation:s.situation, level:s.level, phrase:s.phrase, meaning:s.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const ws = buildQuickSession(words, settings, 10);
  const ss = buildQuickSituationSession(sits, settings, 3);
  const map = Object.fromEntries(words.map((w) => [w.id, w]));
  check(`words ≤ 10 (got ${ws.total})`,         ws.total <= 10);
  check(`sits ≤ 3 (got ${ss.total})`,            ss.total <= 3);
  check("all words are A1",                      ws.ids.every((id) => map[id]?.level === level));
  check("no duplicate ids",                      new Set(ws.ids).size === ws.ids.length);
}));

tests.push(suite("First session: ≤10 words / ≤3 situations / same level — A2", async (check) => {
  const { buildQuickSession, buildQuickSituationSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const { STARTER_SITUATIONS } = await data("starterSituations.js");
  const level = "A2";
  const settings = { ...DEFAULT_SETTINGS, level };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const sits  = STARTER_SITUATIONS.map((s) => ({ id:Math.random().toString(36).slice(2), situation:s.situation, level:s.level, phrase:s.phrase, meaning:s.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const ws = buildQuickSession(words, settings, 10);
  const ss = buildQuickSituationSession(sits, settings, 3);
  const map = Object.fromEntries(words.map((w) => [w.id, w]));
  check(`words ≤ 10 (got ${ws.total})`,  ws.total <= 10);
  check(`sits ≤ 3 (got ${ss.total})`,    ss.total <= 3);
  check("all words are A2",              ws.ids.every((id) => map[id]?.level === level));
  check("no duplicate ids",              new Set(ws.ids).size === ws.ids.length);
}));

tests.push(suite("First session: ≤10 words / ≤3 situations / same level — B1", async (check) => {
  const { buildQuickSession, buildQuickSituationSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const { STARTER_SITUATIONS } = await data("starterSituations.js");
  const level = "B1";
  const settings = { ...DEFAULT_SETTINGS, level };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const sits  = STARTER_SITUATIONS.map((s) => ({ id:Math.random().toString(36).slice(2), situation:s.situation, level:s.level, phrase:s.phrase, meaning:s.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const ws = buildQuickSession(words, settings, 10);
  const ss = buildQuickSituationSession(sits, settings, 3);
  const map = Object.fromEntries(words.map((w) => [w.id, w]));
  check(`words ≤ 10 (got ${ws.total})`,  ws.total <= 10);
  check(`sits ≤ 3 (got ${ss.total})`,    ss.total <= 3);
  check("all words are B1",              ws.ids.every((id) => map[id]?.level === level));
  check("no duplicate ids",              new Set(ws.ids).size === ws.ids.length);
}));

tests.push(suite("First session: ≤10 words / ≤3 situations / same level — B2", async (check) => {
  const { buildQuickSession, buildQuickSituationSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const { STARTER_SITUATIONS } = await data("starterSituations.js");
  const level = "B2";
  const settings = { ...DEFAULT_SETTINGS, level };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const sits  = STARTER_SITUATIONS.map((s) => ({ id:Math.random().toString(36).slice(2), situation:s.situation, level:s.level, phrase:s.phrase, meaning:s.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const ws = buildQuickSession(words, settings, 10);
  const ss = buildQuickSituationSession(sits, settings, 3);
  const map = Object.fromEntries(words.map((w) => [w.id, w]));
  check(`words ≤ 10 (got ${ws.total})`,  ws.total <= 10);
  check(`sits ≤ 3 (got ${ss.total})`,    ss.total <= 3);
  check("all words are B2",              ws.ids.every((id) => map[id]?.level === level));
  check("no duplicate ids",              new Set(ws.ids).size === ws.ids.length);
}));

tests.push(suite("No re-seed on restart (idempotency)", async (check) => {
  const { migrate } = await svc("StorageService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:"w"+Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const seeded = { words, situations:[], streak:{count:1,last:todayStr(),freezesAvailable:2}, settings:{level:"A2"}, starterContentSeeded:true, pendingFirstWordSession:false, pendingFirstSituationSession:false };
  const reloaded = migrate(JSON.parse(JSON.stringify(seeded)));
  check("word count unchanged",               reloaded.words.length === seeded.words.length);
  check("starterContentSeeded stays true",    reloaded.starterContentSeeded === true);
  check("pendingFirstWordSession stays false", reloaded.pendingFirstWordSession === false);
}));

tests.push(suite("Normal caps resume after first session consumed", async (check) => {
  const { buildSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const settings = { ...DEFAULT_SETTINGS, level:"A2" };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const s = buildSession(words, settings);
  check("session > 10 (normal cap, not first-session)",  s.total > 10);
  check("session ≤ dailySessionCap (40)",                s.total <= settings.dailySessionCap);
}));

tests.push(suite("No duplicate scheduling", async (check) => {
  const { buildQuickSession } = await svc("SchedulerService.js");
  const { DEFAULT_SETTINGS } = await svc("SettingsService.js");
  const { emptyWordExtras } = await svc("StorageService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const settings = { ...DEFAULT_SETTINGS, level:"A1" };
  const words = STARTER_VOCABULARY.map((w) => ({ ...emptyWordExtras(), id:Math.random().toString(36).slice(2), word:w.word, meaning:w.meaning, example:w.example||"", category:w.category, level:w.level, createdAt:now, ef:2.5, repetition:0, interval:0, nextReview:todayStr() }));
  const s = buildQuickSession(words, settings, 10);
  check("no duplicate ids in session",                    new Set(s.ids).size === s.ids.length);
  const due = words.filter((w) => w.nextReview <= todayStr() && w.bucket !== "Suspended");
  check("deferred = due - shown",                         s.deferred === due.length - s.total);
}));

/* ---- StorageService migrations ---- */
tests.push(suite("StorageService: v1→v5 migration (no data loss, all fields)", async (check) => {
  const { migrate, SCHEMA_VERSION } = await svc("StorageService.js");
  const v1 = { words:[{ id:"w1", word:"test", meaning:"اختبار", createdAt:now, ef:2.5, repetition:2, interval:6, nextReview:todayStr() }], situations:[], streak:{count:3,last:todayStr()} };
  const out = migrate(v1);
  check("word preserved",                    out.words[0].word === "test");
  check("bucket added",                      typeof out.words[0].bucket === "string");
  check("freeze bank added",                 typeof out.streak.freezesAvailable === "number");
  check("starterContentSeeded = true (has data)", out.starterContentSeeded === true);
  check("pendingFirstWordSession = false",   out.pendingFirstWordSession === false);
  check("__version = current",                     out.__version === SCHEMA_VERSION);
}));

tests.push(suite("StorageService: v4→v5 migration (pending flags added)", async (check) => {
  const { migrate, SCHEMA_VERSION } = await svc("StorageService.js");
  const v4 = { __version:4, words:[], situations:[], streak:{count:0,last:null,freezesAvailable:2}, starterContentSeeded:false };
  const out = migrate(v4);
  check("starterContentSeeded false preserved", out.starterContentSeeded === false);
  check("pendingFirstWordSession added = false", out.pendingFirstWordSession === false);
  check("__version = current",                         out.__version === SCHEMA_VERSION);
}));

/* ---- StreakService ---- */
tests.push(suite("StreakService: freeze covers 1 missed day", async (check) => {
  const { applyDailyStreakUpdate } = await svc("StreakService.js");
  const twoDaysAgo = new Date(Date.now() - 2*86400000).toISOString().slice(0,10);
  const r = applyDailyStreakUpdate({ count:10, last:twoDaysAgo, freezesAvailable:2 }, todayStr());
  check("streak continues",      r.streak.count === 11);
  check("freeze used",           r.freezeUsed === true);
  check("freeze decremented",    r.streak.freezesAvailable === 1);
}));

tests.push(suite("StreakService: milestone at 7 awards a freeze", async (check) => {
  const { applyDailyStreakUpdate } = await svc("StreakService.js");
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
  const r = applyDailyStreakUpdate({ count:6, last:yesterday, freezesAvailable:1 }, todayStr());
  check("count reaches 7",     r.streak.count === 7);
  check("milestoneHit = 7",    r.milestoneHit === 7);
  check("freeze awarded",      r.streak.freezesAvailable === 2);
}));

/* ---- StatisticsService ---- */
tests.push(suite("StatisticsService: leech detection", async (check) => {
  const { findLeeches, LEECH_THRESHOLD } = await svc("StatisticsService.js");
  const words = [
    { id:"a", failureCount:LEECH_THRESHOLD,   bucket:"Review" },
    { id:"b", failureCount:LEECH_THRESHOLD-1, bucket:"Review" },
    { id:"c", failureCount:LEECH_THRESHOLD+3, bucket:"Suspended" },
  ];
  const l = findLeeches(words);
  check("at-threshold is leech",             l.some((w) => w.id==="a"));
  check("below-threshold excluded",          !l.some((w) => w.id==="b"));
  check("suspended excluded despite failures", !l.some((w) => w.id==="c"));
}));

tests.push(suite("StatisticsService: activity heatmap", async (check) => {
  const { computeActivityHeatmap } = await svc("StatisticsService.js");
  const words = [{ reviewHistory:[{ date:new Date().toISOString(), quality:4 }] }];
  const h = computeActivityHeatmap(words, 35);
  check("35 days",           h.length === 35);
  check("last = today",      h[34].date === todayStr());
  check("today count = 1",   h[34].count === 1);
  check("old days count = 0", h[0].count === 0);
}));

/* ---- CSVService ---- */
tests.push(suite("CSVService: duplicate detection", async (check) => {
  const { analyzeWordRows } = await svc("CSVService.js");
  const existing = [{ word:"vast" }];
  const rows = [
    { word:"afford", meaning:"يقدر" },
    { word:"Afford", meaning:"same" },   // case-insensitive dup in batch
    { word:"vast",   meaning:"شاسع" },   // dup against existing
    { word:"",       meaning:"ناقصة" },  // invalid
    { word:"fresh",  meaning:"جديدة" },
  ];
  const a = analyzeWordRows(rows, existing);
  check("afford: valid, not dup",         a[0].__valid && !a[0].__duplicate);
  check("Afford: valid, IS dup",          a[1].__valid && a[1].__duplicate);
  check("vast: valid, IS dup (existing)", a[2].__valid && a[2].__duplicate);
  check("empty word: invalid",            !a[3].__valid);
  check("fresh: valid, not dup",          a[4].__valid && !a[4].__duplicate);
}));

tests.push(suite("CSVService: exportWordsCSV extended fields", async (check) => {
  const { exportWordsCSV } = await svc("CSVService.js");
  const w = { word:"afford", meaning:"يقدر", example:"...", category:"أفعال", level:"B1", bucket:"Weak", confidence:42, repetition:2, interval:6, ef:2.3, nextReview:todayStr(), successCount:3, failureCount:5, lapses:2, favorite:true };
  const csv = exportWordsCSV([w]);
  check("bucket in CSV",      csv.includes("bucket") && csv.includes("Weak"));
  check("confidence in CSV",  csv.includes("confidence") && csv.includes("42"));
  check("failureCount in CSV",csv.includes("failureCount") && csv.includes("5"));
  check("favorite as yes/no", csv.includes("yes"));
}));

/* ---- Starter data integrity ---- */
tests.push(suite("Starter vocabulary: 500 words, balanced, unique, Arabic", async (check) => {
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  check("exactly 500",        STARTER_VOCABULARY.length === 500);
  const levels = {};
  STARTER_VOCABULARY.forEach((w) => levels[w.level] = (levels[w.level]||0)+1);
  check("A1=100", levels.A1 === 100);
  check("A2=100", levels.A2 === 100);
  check("B1=100", levels.B1 === 100);
  check("B2=100", levels.B2 === 100);
  check("C1=100", levels.C1 === 100);
  check("no C2", !levels.C2);
  check("no duplicates",      new Set(STARTER_VOCABULARY.map((w) => w.word.toLowerCase())).size === 500);
  check("all have meaning",   STARTER_VOCABULARY.every((w) => w.meaning));
  const ar = /[\u0600-\u06FF]/;
  check("all meanings Arabic",STARTER_VOCABULARY.every((w) => ar.test(w.meaning)));
}));

tests.push(suite("Starter situations: 197 unique, Arabic", async (check) => {
  const { STARTER_SITUATIONS } = await data("starterSituations.js");
  check("exactly 197",         STARTER_SITUATIONS.length === 197);
  check("no duplicate phrases",new Set(STARTER_SITUATIONS.map((s) => s.phrase.toLowerCase())).size === 197);
  check("all have phrase+meaning", STARTER_SITUATIONS.every((s) => s.phrase && s.meaning));
  const ar = /[\u0600-\u06FF]/;
  check("all meanings Arabic", STARTER_SITUATIONS.every((s) => ar.test(s.meaning)));
}));

/* ------------------------------------------------------------------ */
tests.push(suite("DailyLockService: independent daily locks", async (check) => {
  const { isLocked, markSessionComplete, unlockPatch } = await svc("DailyLockService.js");
  const T = "2026-10-10", Y = "2026-10-09";
  const base = { settings: { isPremium: false }, wordsSessionUsedDate: null, wordsUnlockedDate: null, situationsSessionUsedDate: null, situationsUnlockedDate: null };
  check("not locked at start of day", !isLocked(base, "words", T) && !isLocked(base, "situations", T));
  const afterWords = { ...base, ...markSessionComplete(base, "words", T) };
  check("words locked after a completed session", isLocked(afterWords, "words", T));
  check("situations NOT locked by words session", !isLocked(afterWords, "situations", T));
  const afterSit = { ...afterWords, ...markSessionComplete(afterWords, "situations", T) };
  check("situations locked independently", isLocked(afterSit, "situations", T));
  check("lock renews next day", !isLocked(afterSit, "words", "2026-10-11") && !isLocked(afterSit, "situations", "2026-10-11"));
  const unlocked = { ...afterWords, ...unlockPatch("words", T) };
  check("ad unlock opens words for today", !isLocked(unlocked, "words", T));
  check("ad unlock does not open situations", isLocked(afterSit, "situations", T));
  const again = { ...unlocked, ...markSessionComplete(unlocked, "words", T) };
  check("finishing the extra session locks again", isLocked(again, "words", T));
  check("yesterday's use does not lock today", !isLocked({ ...base, wordsSessionUsedDate: Y }, "words", T));
  check("premium never locked", !isLocked({ ...afterSit, settings: { isPremium: true } }, "words", T));
}));

tests.push(suite("Settings caps: new+old+review never exceed the total", async (check) => {
  const { clampCaps, capMax } = await svc("SettingsService.js");
  const sum = (c) => c.newC + c.oldC + c.review;
  const ok = clampCaps({ session: 40, newC: 8, oldC: 10, review: 25 });
  check("fits → unchanged apart from trimming overflow (43 > 40)", sum(ok) <= 40);
  const shrunk = clampCaps({ session: 10, newC: 8, oldC: 10, review: 25 });
  check("shrinking total trims to ≤ total", sum(shrunk) <= 10 && shrunk.session === 10);
  check("review trimmed first", shrunk.review === 0 && shrunk.oldC <= 10);
  const tiny = clampCaps({ session: 5, newC: 8, oldC: 10, review: 25 });
  check("tiny total still valid", sum(tiny) <= 5);
  check("capMax = total − others", capMax({ session: 30, newC: 5, oldC: 10, review: 5 }, "newC") === 15);
  check("capMax never negative", capMax({ session: 5, newC: 5, oldC: 10, review: 5 }, "newC") === 0);
  check("negative/NaN safe", sum(clampCaps({ session: 20, newC: -3, oldC: "x", review: 4 })) === 4);
}));

tests.push(suite("LevelCheckService: picks around the level, suggests honestly", async (check) => {
  const { pickLevelCheckWords, evaluateLevelCheck } = await svc("LevelCheckService.js");
  const { STARTER_VOCABULARY } = await data("starterVocabulary.js");
  const items = pickLevelCheckWords(STARTER_VOCABULARY, "B1");
  check("12 words", items.length === 12);
  check("levels only A2/B1/B2", items.every((i) => ["A2","B1","B2"].includes(i.level)));
  check("5 at chosen level", items.filter((i) => i.level === "B1").length === 5);
  const edge = pickLevelCheckWords(STARTER_VOCABULARY, "A1");
  check("A1 edge: still 12, only A1/A2", edge.length === 12 && edge.every((i) => ["A1","A2"].includes(i.level)));
  const top = pickLevelCheckWords(STARTER_VOCABULARY, "C2");
  check("C2 treated as C1 (no C2 content)", top.length === 12 && top.every((i) => ["B2","C1"].includes(i.level)));
  const all = (a) => items.map(() => a);
  check("knows everything → higher", evaluateLevelCheck(items, all("know"), "B1").verdict === "higher");
  check("knows nothing → lower", evaluateLevelCheck(items, all("no"), "B1").verdict === "lower");
  const mixed = items.map((i) => (i.level === "B2" ? "no" : "know"));
  check("strong at level, weak above → ok", evaluateLevelCheck(items, mixed, "B1").verdict === "ok");
  check("A1 never suggests lower", evaluateLevelCheck(edge, edge.map(() => "no"), "A1").suggested === "A1");
}));

tests.push(suite("Weak rule: one failure → Weak, 3 correct → recover", async (check) => {
  const { applySM2, applyPerformanceTracking, nextBucket } = await svc("SM2Engine.js");
  let w = { ef: 2.5, repetition: 0, interval: 0, bucket: "Unknown", consecutiveCorrect: 0, consecutiveFailures: 0, successCount: 0, failureCount: 0 };
  const review = (w, q) => { const sm = applySM2(w, q), pf = applyPerformanceTracking(w, q); return { ...w, ...sm, ...pf, bucket: nextBucket(w.bucket, { correctStreak: pf.consecutiveCorrect, wrongStreak: pf.consecutiveFailures }) }; };
  w = review(w, 0);
  check("new word marked wrong → Weak", w.bucket === "Weak");
  w = review(w, 4); w = review(w, 4);
  check("2 correct still Weak", w.bucket === "Weak");
  w = review(w, 4);
  check("3 correct → Review", w.bucket === "Review");
}));

async function main() {
  console.log("حصيلتي — test suite\n");
  for (const t of tests) await t();
  console.log(`\n${"─".repeat(44)}`);
  console.log(`Checks: ${totalPassed+totalFailed} | Passed: ${totalPassed} | Failed: ${totalFailed}`);
  console.log(`Suites: ${suitesPassed} passed, ${suitesFailed} failed`);
  if (totalFailed > 0) { console.error("\n✗ SOME TESTS FAILED"); process.exit(1); }
  else                  { console.log("\n✓ ALL TESTS PASSED"); }
}
main();
