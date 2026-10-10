/**
 * SchedulerService
 * -----------------------------------------------------------------------
 * Single source of truth for turning "everything due today" into an actual
 * capped daily session. Both words and situations go through the same
 * buildLeveledSession() so a bulk CSV import of either never dumps its
 * whole contents into one sitting - see the long comment on
 * buildLeveledSession for the full reasoning.
 *
 * NOTE (scope): this still uses the level-tiered known/review/new split
 * (relative to the user's chosen CEFR level), not the six-bucket
 * Unknown/Learning/Weak/Review/Mastered/Suspended state machine. The word
 * model already carries the fields that state machine needs (see
 * StorageService's migration), but wiring the scheduler to prioritize by
 * bucket/state instead of level is a separate, bigger change - flagged
 * for the next phase rather than folded in here silently.
 */

const todayStr = () => new Date().toISOString().slice(0, 10);
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function levelIndex(lvl) {
  const i = LEVELS.indexOf((lvl || "").toUpperCase());
  return i === -1 ? null : i;
}

/* Every item falls into one of three buckets relative to the chosen level:
   - known  (item level is BELOW the chosen level)  -> already mastered material, light upkeep only
   - review (item level EQUALS the chosen level)     -> today's main focus, capped like the others
   - new    (item level is ABOVE the chosen level)   -> upcoming vocabulary, introduced a few at a time
   Items with no level tag are treated as "review" since there's no basis
   to push them into known/new. */
export function bucketOf(item, selectedLevel) {
  const wi = levelIndex(item.level);
  const si = levelIndex(selectedLevel);
  if (wi === null || si === null) return "review";
  if (wi < si) return "known";
  if (wi === si) return "review";
  return "new";
}

/** Deterministic pseudo-random 0..1 value derived from a string id. Same
 * id always maps to the same value (so a decision based on it doesn't
 * flicker between renders), without needing to store anything extra. */
export function hashToUnit(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Builds one day's session out of `items` (words OR situations - same
 * shape needed: id, level, repetition, nextReview, createdAt). Words also
 * carry a `bucket` (see SM2Engine's six-bucket state machine) which this
 * function respects two ways - situations don't have a bucket field, so
 * both checks below simply no-op for them:
 * - items whose bucket is "Suspended" are excluded entirely, regardless
 *   of how overdue they are - that's what suspending a word means.
 * - items whose bucket is "Weak" are sorted to the front of the known/
 *   review buckets before capping, so a struggling word survives the cap
 *   instead of being silently pushed out by less urgent due items, and
 *   they're shown first in the shuffled queue too.
 *
 * Protections, all of which existed as gaps before this phase:
 * - "review" (same level) used to be unlimited -> now capped too
 *   (weak-first, then most-overdue-first), so a big CSV import or coming
 *   back after days away doesn't dump the whole backlog into one sitting.
 * - "sessionCap" is an overall ceiling on the whole session regardless of
 *   how the buckets add up. Anything left over simply stays "due" and
 *   resurfaces next time - nothing is lost, it's just spread out.
 */
export function buildLeveledSession(items, level, caps) {
  const today = todayStr();
  const due = items.filter((it) => it.nextReview <= today && it.bucket !== "Suspended");
  const known = [], review = [], newFresh = [], newStarted = [];
  due.forEach((it) => {
    const b = bucketOf(it, level);
    if (b === "known") known.push(it);
    else if (b === "review") review.push(it);
    else if ((it.repetition || 0) === 0) newFresh.push(it);
    else newStarted.push(it);
  });
  newFresh.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest imported first
  const weakThenOverdue = (a, b) => {
    const aw = a.bucket === "Weak" ? 0 : 1;
    const bw = b.bucket === "Weak" ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return new Date(a.nextReview) - new Date(b.nextReview); // most overdue first
  };
  known.sort(weakThenOverdue);
  review.sort(weakThenOverdue);

  const cappedKnown = known.slice(0, caps.oldCap);
  const cappedNew = newFresh.slice(0, caps.newCap);
  const cappedReview = review.slice(0, caps.reviewCap);

  // Priority for the overall session cap: items already mid-cycle (due
  // reviews + already-started new items) matter most, then known upkeep,
  // then brand-new introductions.
  const pool = [...cappedReview, ...newStarted, ...cappedKnown, ...cappedNew];
  const finalPool = pool.slice(0, caps.sessionCap);
  const finalIds = new Set(finalPool.map((it) => it.id));

  // Weak items go first in the actual queue too (still shuffled within
  // each group), so struggling words get retrieval priority in-session.
  const weakItems = finalPool.filter((it) => it.bucket === "Weak");
  const restItems = finalPool.filter((it) => it.bucket !== "Weak");
  const ids = [...shuffle(weakItems), ...shuffle(restItems)].map((it) => it.id);

  return {
    ids,
    total: ids.length,
    breakdown: {
      known: cappedKnown.filter((it) => finalIds.has(it.id)).length,
      review: [...cappedReview, ...newStarted].filter((it) => finalIds.has(it.id)).length,
      new: cappedNew.filter((it) => finalIds.has(it.id)).length,
    },
    deferred: due.length - ids.length, // stayed due, just not shown this session
  };
}

export function buildSession(words, settings) {
  return buildLeveledSession(words, settings.level, {
    newCap: settings.dailyNewCap,
    oldCap: settings.dailyOldCap,
    reviewCap: settings.dailyReviewCap,
    sessionCap: settings.dailySessionCap,
  });
}

export function buildSituationSession(situations, settings) {
  return buildLeveledSession(situations, settings.level, {
    newCap: settings.dailySituationNewCap,
    oldCap: settings.dailySituationOldCap,
    reviewCap: settings.dailySituationReviewCap,
    sessionCap: settings.dailySituationSessionCap,
  });
}

/** A deliberately tiny session (default 5 words) for the "too busy today,
 * just let me keep the streak alive" case - the "two-minute rule": the
 * barrier to doing *something* today should be as low as possible. Reuses
 * the normal caps/priority ordering (so weak words still surface first),
 * just with a much smaller overall ceiling. */
export function buildQuickSession(words, settings, quickCap = 5) {
  return buildLeveledSession(words, settings.level, {
    newCap: settings.dailyNewCap,
    oldCap: settings.dailyOldCap,
    reviewCap: settings.dailyReviewCap,
    sessionCap: Math.min(quickCap, settings.dailySessionCap),
  });
}

/** Twin of buildQuickSession for situations - used for the one-time
 * "first session after starter-content seeding" cap (see App.jsx's
 * pendingFirstSituationSession), so a freshly-seeded library doesn't dump
 * dozens of situations into someone's very first look at the app. */
export function buildQuickSituationSession(situations, settings, quickCap = 3) {
  return buildLeveledSession(situations, settings.level, {
    newCap: settings.dailySituationNewCap,
    oldCap: settings.dailySituationOldCap,
    reviewCap: settings.dailySituationReviewCap,
    sessionCap: Math.min(quickCap, settings.dailySituationSessionCap),
  });
}
