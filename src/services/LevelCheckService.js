/**
 * LevelCheckService
 * -----------------------------------------------------------------------
 * Short, skippable first-run check that tests words AROUND the level the
 * person picked (a few below, mostly at, a few above) and says whether the
 * pick looks right or closer to another level. It only ever SUGGESTS - the
 * person decides. Pure functions, no UI, no storage.
 */
export const CHECK_LEVELS = ["A1", "A2", "B1", "B2", "C1"]; // no C2 content exists

const clampIdx = (i) => Math.max(0, Math.min(CHECK_LEVELS.length - 1, i));

function pick(arr, n, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/** Chosen level can be C2 (no content) - treated as C1 for testing. */
export function pickLevelCheckWords(vocabulary, chosenLevel, rng = Math.random, plan = { below: 3, at: 5, above: 4 }) {
  const idx = clampIdx(CHECK_LEVELS.indexOf(chosenLevel) === -1 ? CHECK_LEVELS.length - 1 : CHECK_LEVELS.indexOf(chosenLevel));
  const by = (lvl) => vocabulary.filter((w) => w.level === lvl);
  const items = [];
  const add = (lvl, n) => pick(by(lvl), n, rng).forEach((w) => items.push({ ...w, level: lvl }));
  // At the edges, shift the unused slots to the neighbouring side so the
  // test always has the same length.
  const belowLvl = idx > 0 ? CHECK_LEVELS[idx - 1] : null;
  const aboveLvl = idx < CHECK_LEVELS.length - 1 ? CHECK_LEVELS[idx + 1] : null;
  add(CHECK_LEVELS[idx], plan.at);
  if (belowLvl) add(belowLvl, plan.below + (aboveLvl ? 0 : plan.above));
  if (aboveLvl) add(aboveLvl, plan.above + (belowLvl ? 0 : plan.below));
  return items.sort((a, b) => CHECK_LEVELS.indexOf(a.level) - CHECK_LEVELS.indexOf(b.level));
}

const SCORE = { know: 1, unsure: 0.5, no: 0 };

/**
 * items: [{ level }], answers: parallel array of "know" | "unsure" | "no".
 * Returns per-level rates and a verdict relative to the chosen level.
 */
export function evaluateLevelCheck(items, answers, chosenLevel) {
  const totals = {}, got = {};
  items.forEach((it, i) => {
    totals[it.level] = (totals[it.level] || 0) + 1;
    got[it.level] = (got[it.level] || 0) + (SCORE[answers[i]] ?? 0);
  });
  const rates = {};
  Object.keys(totals).forEach((l) => { rates[l] = got[l] / totals[l]; });
  const chosenIdx = clampIdx(CHECK_LEVELS.indexOf(chosenLevel) === -1 ? CHECK_LEVELS.length - 1 : CHECK_LEVELS.indexOf(chosenLevel));
  const chosen = CHECK_LEVELS[chosenIdx];
  const above = CHECK_LEVELS[chosenIdx + 1];
  const below = CHECK_LEVELS[chosenIdx - 1];
  const at = rates[chosen] ?? 0;
  let verdict = "ok", suggested = chosen;
  if (at >= 0.8 && above && (rates[above] ?? 0) >= 0.6) { verdict = "higher"; suggested = above; }
  else if (at < 0.4 && below) { verdict = "lower"; suggested = below; }
  return { verdict, suggested, chosen, rates, atRate: at };
}
