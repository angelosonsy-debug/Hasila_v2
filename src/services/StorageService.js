/**
 * StorageService
 * -----------------------------------------------------------------------
 * Single source of truth for reading/writing the app's data in
 * localStorage, and for migrating older saved data to the current schema
 * WITHOUT ever dropping existing vocabulary, situations, or settings.
 *
 * Schema history:
 *   v1 (implicit, no __version field) - the original flat word/situation
 *     shape: id, word, meaning, example, category, level, createdAt, ef,
 *     repetition, interval, nextReview.
 *   v2 - adds the extended word model (ipa, synonyms, antonyms, word
 *     family, notes, bucket/state, confidence, lapses, success/failure
 *     counters, review history, favorite, suspended) so future phases
 *     (six-bucket learning system, statistics, active recall difficulty)
 *     have somewhere to read/write without another migration. Existing
 *     fields are never touched or removed - only missing fields are
 *     filled in with safe defaults.
 *   v3 - adds streak.freezesAvailable (streak-freeze forgiveness, see
 *     StreakService) - old streaks migrate in with the default freeze
 *     bank, count/last untouched.
 *   v4 - adds data.starterContentSeeded (starter vocabulary/situations
 *     opt-in tracking, see App.jsx's pickLevelAndSeed). CRITICAL migration
 *     rule: any user migrating from an earlier version who already has
 *     ANY words or situations is marked seeded=true immediately, so the
 *     starter-content flow can never run for them and silently inject
 *     data they didn't ask for - only a genuinely brand-new install
 *     (nothing in localStorage at all) can ever see seeded=false.
 *   v5 - adds data.pendingFirstWordSession / pendingFirstSituationSession
 *     (one-time small first-session cap right after starter-content
 *     seeding, see App.jsx and SchedulerService's buildQuickSession/
 *     buildQuickSituationSession). Always defaults to false on migration -
 *     these only ever get set true by pickLevelAndSeed itself, at the
 *     moment of a fresh seed, never retroactively for an existing save
 *     file (which would unexpectedly shrink someone's next session).
 *   v6 - adds the independent daily-lock dates (DailyLockService).
 */
import { stageOf } from "./SM2Engine.js";
import { normalizeSettings } from "./SettingsService.js";
import { normalizeStreak } from "./StreakService.js";

export const STORAGE_KEY = "vocab-app-data";
export const SCHEMA_VERSION = 6;

const BUCKETS = ["Unknown", "Learning", "Weak", "Review", "Mastered", "Suspended"];

/** The extended-model fields every word needs, with safe defaults. Used
 * both for migrating old saved words and for creating brand-new ones, so
 * there's exactly one place that knows this field list. */
export function emptyWordExtras() {
  return {
    ipa: "", synonyms: [], antonyms: [], wordFamily: [], notes: "",
    bucket: "Unknown", confidence: 50, lapses: 0,
    successCount: 0, failureCount: 0, consecutiveCorrect: 0, consecutiveFailures: 0,
    lastReview: null, reviewHistory: [], favorite: false, suspended: false,
    placementDone: false,
  };
}

/** Best-effort initial bucket for a pre-existing word, derived from its
 * current SM-2 progress. There's no failure history for old words to base
 * "Weak" on, so migration never assigns Weak/Suspended - those only ever
 * come from actual review performance going forward (see AdaptiveLearning
 * rules, wired into the scheduler in a later phase). */
function initialBucket(w) {
  const stage = stageOf(w);
  if (stage === 0) return "Unknown";
  if (stage === 1 || stage === 2) return "Learning";
  if (stage === 4) return "Mastered";
  return "Review";
}

function migrateWord(w) {
  const extras = emptyWordExtras();
  return {
    ...extras,
    ...w,
    bucket: BUCKETS.includes(w.bucket) ? w.bucket : initialBucket(w),
  };
}

/** Migrates a raw parsed object (whatever shape/version it was saved as)
 * up to SCHEMA_VERSION, additively. Never throws on missing arrays - just
 * treats them as empty rather than failing the whole load. */
export function migrate(parsed) {
  const data = { ...parsed };
  const words = Array.isArray(data.words) ? data.words : [];
  data.words = words.map(migrateWord);
  data.situations = Array.isArray(data.situations) ? data.situations : [];
  data.streak = normalizeStreak(data.streak);
  // Idempotent starter-content flag: ANY pre-existing user (had a save
  // file at all, regardless of what version) who already has words or
  // situations is considered already "seeded" - starter content must
  // never retroactively get injected into someone's existing library.
  // Only stays false for a truly first-ever save.
  if (typeof data.starterContentSeeded !== "boolean") {
    data.starterContentSeeded = data.words.length > 0 || data.situations.length > 0;
  }
  // See v5 note above: these must default false for every migrating save
  // file, never inferred from existing content the way starterContentSeeded
  // is - they're only ever set true by a live seed happening from now on.
  if (typeof data.pendingFirstWordSession !== "boolean") data.pendingFirstWordSession = false;
  if (typeof data.pendingFirstSituationSession !== "boolean") data.pendingFirstSituationSession = false;
  if (!('situationsReviewedDate' in data)) data.situationsReviewedDate = null;
  // v6: independent daily locks (see DailyLockService). All default null -
  // never locked retroactively on migration.
  for (const k of ["wordsSessionUsedDate", "wordsUnlockedDate", "situationsSessionUsedDate", "situationsUnlockedDate"]) {
    if (!(k in data)) data[k] = null;
  }

  data.__version = SCHEMA_VERSION;
  return data;
}

/** Loads and migrates saved data. Returns null if there's nothing saved
 * yet (first run) or the saved data is unreadable - callers should fall
 * back to a fresh empty state, never crash. */
export function loadData() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const migrated = migrate(parsed);
    return { ...migrated, settings: normalizeSettings(migrated.settings) };
  } catch (e) {
    console.error("StorageService: failed to load saved data, starting fresh", e);
    return null;
  }
}

export function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, __version: SCHEMA_VERSION }));
    return true;
  } catch (e) {
    console.error("StorageService: save failed", e);
    return false;
  }
}
