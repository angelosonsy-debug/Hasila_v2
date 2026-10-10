/**
 * StreakService
 * -----------------------------------------------------------------------
 * Single source of truth for the daily streak, including "freezes" (a
 * small bank of missed-day forgiveness) and milestone detection.
 *
 * Why freezes matter: an all-or-nothing streak (miss one day, back to 0)
 * is a strong reason people abandon a habit entirely after the first
 * slip - the whole point of the "reward" principle in Atomic Habits is
 * that the system should feel forgiving enough to come back to, not
 * punishing enough to quit. A small forgiving buffer keeps the streak
 * (and the reason to open the app) alive through a genuinely busy day -
 * relevant here given Angelos's irregular military-service schedule.
 */
export const FREEZE_CAP = 2;
export const MILESTONES = [7, 30, 100, 365];

export function initialStreak() {
  return { count: 0, last: null, freezesAvailable: FREEZE_CAP };
}

/** Fills in freezesAvailable for streak objects saved before this feature
 * existed, without touching count/last. */
export function normalizeStreak(streak) {
  return { count: streak?.count || 0, last: streak?.last || null, freezesAvailable: streak?.freezesAvailable ?? FREEZE_CAP };
}

/**
 * Call once per day the person reviews anything (word or situation) -
 * reviewing a single item is enough to count the day, matching the
 * "two-minute rule": the barrier to keeping the streak alive should be
 * as low as physically possible.
 *
 * Returns the updated streak plus two flags the UI can react to:
 * - freezeUsed: a missed day was silently covered by a freeze
 * - milestoneHit: the exact day-count just reached (7/30/100/365) or null
 */
export function applyDailyStreakUpdate(streak, todayStr) {
  const s = normalizeStreak(streak);
  if (s.last === todayStr) {
    return { streak: s, freezeUsed: false, milestoneHit: null }; // already counted today
  }

  let newCount;
  let freezeUsed = false;
  let freezesAvailable = s.freezesAvailable;

  if (!s.last) {
    newCount = 1; // very first review ever
  } else {
    const daysSince = Math.round((new Date(todayStr) - new Date(s.last)) / 86400000);
    const missedDays = daysSince - 1; // days with no review in between
    if (missedDays <= 0) {
      newCount = s.count + 1; // reviewed yesterday, streak continues normally
    } else if (freezesAvailable >= missedDays) {
      freezesAvailable -= missedDays;
      newCount = s.count + 1;
      freezeUsed = true;
    } else {
      newCount = 1; // gap too large to cover, streak restarts
    }
  }

  let milestoneHit = null;
  if (MILESTONES.includes(newCount)) {
    milestoneHit = newCount;
    if (freezesAvailable < FREEZE_CAP) freezesAvailable += 1; // earn a freeze back as a milestone reward
  }

  return { streak: { count: newCount, last: todayStr, freezesAvailable }, freezeUsed, milestoneHit };
}
