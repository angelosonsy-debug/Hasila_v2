/**
 * StatisticsService
 * -----------------------------------------------------------------------
 * Single source of truth for deriving stats from the raw word list -
 * nothing here mutates state, it only reads successCount/failureCount/
 * reviewHistory/bucket (already tracked by SM2Engine on every review) and
 * summarizes them.
 */
const todayStr = () => new Date().toISOString().slice(0, 10);

export function computeStatistics(words, streak) {
  let totalSuccess = 0, totalFailure = 0, todayReviews = 0;
  const bucketCounts = {};
  words.forEach((w) => {
    totalSuccess += w.successCount || 0;
    totalFailure += w.failureCount || 0;
    const b = w.bucket || "Unknown";
    bucketCounts[b] = (bucketCounts[b] || 0) + 1;
    (w.reviewHistory || []).forEach((r) => {
      if ((r.date || "").slice(0, 10) === todayStr()) todayReviews += 1;
    });
  });
  const totalReviews = totalSuccess + totalFailure;
  const accuracy = totalReviews > 0 ? Math.round((totalSuccess / totalReviews) * 100) : 0;
  const hardestWords = [...words]
    .filter((w) => (w.failureCount || 0) > 0)
    .sort((a, b) => (b.failureCount || 0) - (a.failureCount || 0) || (b.lapses || 0) - (a.lapses || 0))
    .slice(0, 5);

  return {
    totalReviews,
    accuracy,
    todayReviews,
    weakCount: bucketCounts.Weak || 0,
    masteredCount: bucketCounts.Mastered || 0,
    suspendedCount: bucketCounts.Suspended || 0,
    hardestWords,
    streakCount: streak?.count || 0,
  };
}

/** Words that keep coming back wrong no matter how many times they're
 * reviewed ("leeches" in SRS terminology) - distinct from "Weak" bucket
 * membership, which only reflects the current streak of consecutive
 * misses and can clear after 3 good answers. A leech is flagged by total
 * lifetime failure count crossing a threshold, so it stays visible as a
 * word worth extra attention (a mnemonic, a different example sentence,
 * etc.) even after it temporarily recovers into Review or Mastered. */
export const LEECH_THRESHOLD = 5;

export function findLeeches(words) {
  return [...words]
    .filter((w) => (w.failureCount || 0) >= LEECH_THRESHOLD && w.bucket !== "Suspended")
    .sort((a, b) => (b.failureCount || 0) - (a.failureCount || 0));
}

/** Aggregates review activity (from every word's reviewHistory) into a
 * per-day count for the last `days` days, for a GitHub-style activity
 * grid. Note: each word only keeps its last 50 review events, so for a
 * very high-volume learner the oldest days in a wide window could
 * undercount - fine for the default ~5 week view this is used for. */
export function computeActivityHeatmap(words, days = 35) {
  const counts = {};
  words.forEach((w) => {
    (w.reviewHistory || []).forEach((r) => {
      const day = (r.date || "").slice(0, 10);
      if (!day) return;
      counts[day] = (counts[day] || 0) + 1;
    });
  });
  const today = new Date();
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: counts[key] || 0 });
  }
  return result;
}
