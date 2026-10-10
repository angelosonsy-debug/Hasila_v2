/**
 * SM2Engine
 * -----------------------------------------------------------------------
 * Single source of truth for spaced-repetition scheduling math (SM-2).
 * No component should compute ef/interval/repetition by hand - everything
 * goes through applySM2() so there's exactly one place that can drift from
 * the algorithm.
 *
 * Quality scale used throughout the app: 0 = wrong/forgot, 3 = hard,
 * 4 = good, 5 = easy.
 */

/** Pure SM-2 step: given the item's current scheduling state and how the
 * person did just now, returns the *next* ef/repetition/interval/nextReview.
 * Does not mutate the input item. */
export function applySM2(item, quality) {
  let { ef = 2.5, repetition = 0, interval = 0 } = item;
  if (quality < 3) {
    repetition = 0;
    interval = 1; // wrong answers come back tomorrow, not "further away"
  } else {
    if (repetition === 0) interval = 1;
    else if (repetition === 1) interval = 6;
    else interval = Math.round(interval * ef);
    repetition += 1;
  }
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;
  const next = new Date();
  next.setDate(next.getDate() + interval);
  return { ef, repetition, interval, nextReview: next.toISOString().slice(0, 10) };
}

/** Rolls the extra performance-tracking fields (used by the bucket/state
 * system) forward alongside applySM2. Kept as a separate, explicit step
 * so callers that only need scheduling (e.g. situations, which don't have
 * a bucket system yet) can call applySM2 alone. */
export function applyPerformanceTracking(item, quality) {
  const correct = quality >= 3;
  const successCount = (item.successCount || 0) + (correct ? 1 : 0);
  const failureCount = (item.failureCount || 0) + (correct ? 0 : 1);
  const consecutiveCorrect = correct ? (item.consecutiveCorrect || 0) + 1 : 0;
  const consecutiveFailures = correct ? 0 : (item.consecutiveFailures || 0) + 1;
  const lapses = (item.lapses || 0) + (correct ? 0 : (item.repetition > 0 ? 1 : 0));
  const reviewHistory = [...(item.reviewHistory || []), { date: new Date().toISOString(), quality }].slice(-50);
  // Confidence: simple bounded walk, nudged by each review. Not used to
  // drive scheduling yet (that's the bucket system, Phase 3) - stored now
  // so that phase doesn't need another migration.
  const confidence = Math.max(0, Math.min(100, (item.confidence ?? 50) + (correct ? 4 : -8)));
  return { successCount, failureCount, consecutiveCorrect, consecutiveFailures, lapses, reviewHistory, confidence };
}

export function stageOf(item) {
  const r = item.repetition || 0;
  if (r === 0) return 0;
  if (r === 1) return 1;
  if (r === 2) return 2;
  if (item.interval >= 30) return 4;
  return 3;
}

export const STAGE_LABEL = ["جديدة", "قيد التعلم", "ناشئة", "متقدمة", "متقنة"];
export const STAGE_COLOR = ["#9a9284", "#c1785b", "#c99a3f", "#5c8f7d", "#3a6b5c"];

/* ---------------- Adaptive learning: the six-bucket state machine ----------------
   Every word carries an explicit `bucket`, separate from its SM-2 numbers:
   Unknown -> Learning -> Review -> Mastered, with Weak as a demotion path
   that can happen from any state (even straight out of Mastered - a word
   you thought you knew but keep failing needs attention now, not gentle
   maintenance), and Suspended as a manual "skip this for now" the person
   sets themselves and which nothing here auto-changes.

   Driven by actual performance (the consecutiveCorrect/consecutiveFailures
   counters applyPerformanceTracking already tracks - no new fields needed):
   - 2 consecutive wrong answers -> Weak, regardless of prior bucket.
   - 8 consecutive correct answers -> Mastered.
   - Recovering from Weak needs 3 consecutive correct answers before
     graduating back to Review - one lucky guess isn't "fixed".
   - First ever correct review moves a word out of Unknown/Learning.
   Thresholds are plain constants so they're easy to tune without touching
   call sites. */
// weakAfterWrongStreak = 1: a single "I don't know it" already puts a word
// in Weak (the person told us it's hard - waiting for a second miss hid
// words they had explicitly marked unknown). Mastered words are given one
// extra chance (masteredWeakAfterWrongStreak = 2) since a slip on a
// well-learned word is usually a lapse, not lost knowledge.
export const ADAPTIVE_RULES = { weakAfterWrongStreak: 1, masteredWeakAfterWrongStreak: 2, masteredAfterCorrectStreak: 8, recoverFromWeakAfterCorrectStreak: 3 };

export function nextBucket(prevBucket, { correctStreak, wrongStreak }) {
  if (prevBucket === "Suspended") return "Suspended"; // manual state, reviews don't touch it
  const weakAt = prevBucket === "Mastered" ? ADAPTIVE_RULES.masteredWeakAfterWrongStreak : ADAPTIVE_RULES.weakAfterWrongStreak;
  if (wrongStreak >= weakAt) return "Weak";
  if (correctStreak >= ADAPTIVE_RULES.masteredAfterCorrectStreak) return "Mastered";
  if (prevBucket === "Weak") return correctStreak >= ADAPTIVE_RULES.recoverFromWeakAfterCorrectStreak ? "Review" : "Weak";
  if (prevBucket === "Mastered") return "Mastered";
  if (prevBucket === "Unknown" || prevBucket === "Learning") return correctStreak >= 1 ? "Review" : "Learning";
  return "Review";
}

export const BUCKET_LABEL = { Unknown: "غير مقيّمة", Learning: "قيد التعلم", Weak: "ضعيفة", Review: "مراجعة", Mastered: "متقنة", Suspended: "متجاهلة" };
export const BUCKET_COLOR = { Unknown: "#7FB09C", Learning: "#c99a3f", Weak: "#c1785b", Review: "#5c8f7d", Mastered: "#3a6b5c", Suspended: "#6b6b6b" };
