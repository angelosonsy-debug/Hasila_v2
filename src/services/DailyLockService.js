/**
 * DailyLockService
 * -----------------------------------------------------------------------
 * One place that decides whether words / situations reviews are locked
 * today. Rules (free tier):
 *   - Words and situations are INDEPENDENT: finishing a words session
 *     never locks situations, and vice versa.
 *   - Nothing is locked at the start of the day. Once ONE session of a
 *     kind is completed, every review of that kind (flashcards, quick,
 *     listen, weak/leech drills) is locked until the next calendar day.
 *   - Watching a rewarded ad unlocks that kind for the rest of today.
 *   - Premium is never locked.
 * Dates are plain YYYY-MM-DD strings, so the lock renews by itself the
 * next day - nothing needs to be "reset".
 */

export const LOCK_KINDS = { words: "words", situations: "situations" };

const FIELDS = {
  words: { used: "wordsSessionUsedDate", unlocked: "wordsUnlockedDate" },
  situations: { used: "situationsSessionUsedDate", unlocked: "situationsUnlockedDate" },
};

export function isLocked(data, kind, today) {
  if (data?.settings?.isPremium) return false;
  const f = FIELDS[kind];
  if (!f) return false;
  return data[f.used] === today && data[f.unlocked] !== today;
}

/** Returns the patch to apply when a full session of `kind` is completed. */
export function markSessionComplete(data, kind, today) {
  const f = FIELDS[kind];
  // If it was unlocked by an ad today, finishing the extra session locks
  // it again (the unlock was for one more session, not unlimited).
  return { [f.used]: today, [f.unlocked]: null };
}

/** Returns the patch to apply after a rewarded ad unlocks `kind`. */
export function unlockPatch(kind, today) {
  return { [FIELDS[kind].unlocked]: today };
}

export const LOCK_FIELDS = ["wordsSessionUsedDate", "wordsUnlockedDate", "situationsSessionUsedDate", "situationsUnlockedDate"];
