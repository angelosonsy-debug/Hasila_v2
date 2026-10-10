import { exportTextFile } from "./FileExportService.js";
/**
 * CSVService
 * -----------------------------------------------------------------------
 * Single source of truth for CSV parsing, duplicate detection, and export
 * for both words and situations - so AddWord/AddSituation/Dictionary don't
 * each reimplement their own row-mapping or dedup logic.
 */
import Papa from "papaparse";

const norm = (s) => (s || "").trim().toLowerCase();

/* ---------------- Words ---------------- */

export function parseWordsCSV(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  return result.data.map((r) => ({
    word: (r.word || r.Word || "").trim(),
    meaning: (r.meaning || r.Meaning || "").trim(),
    example: (r.example || r.Example || "").trim(),
    category: (r.category || r.Category || "").trim(),
    level: (r.level || r.Level || "").trim().toUpperCase(),
  }));
}

/** Flags each parsed row as valid/invalid (missing required fields) and
 * duplicate (against both the existing vocabulary and earlier rows in
 * this same batch), without adding anything itself - the caller decides
 * what to do with the flags (e.g. show a preview, let the person choose
 * whether to skip duplicates). */
export function analyzeWordRows(rows, existingWords) {
  const existingSet = new Set((existingWords || []).map((w) => norm(w.word)));
  const seenInBatch = new Set();
  return rows.map((r) => {
    const valid = !!(r.word && r.meaning);
    const key = norm(r.word);
    const duplicate = valid && (existingSet.has(key) || seenInBatch.has(key));
    if (valid) seenInBatch.add(key);
    return { ...r, __valid: valid, __duplicate: duplicate };
  });
}

/** Full-fidelity export - includes the adaptive-learning fields (bucket,
 * confidence, lapses, success/failure counts...) alongside the basic
 * word/meaning/example/category/level columns, so a CSV export actually
 * preserves review progress instead of only the raw vocabulary. For a
 * complete backup (including situations, streak, settings) use
 * BackupService's JSON export instead - this is for spreadsheet use. */
export function exportWordsCSV(words) {
  return Papa.unparse(
    words.map((w) => ({
      word: w.word,
      meaning: w.meaning,
      example: w.example,
      category: w.category,
      level: w.level,
      bucket: w.bucket || "Unknown",
      confidence: w.confidence ?? 50,
      repetition: w.repetition || 0,
      interval: w.interval || 0,
      ef: w.ef ?? 2.5,
      nextReview: w.nextReview || "",
      successCount: w.successCount || 0,
      failureCount: w.failureCount || 0,
      lapses: w.lapses || 0,
      favorite: w.favorite ? "yes" : "no",
    }))
  );
}

/* ---------------- Situations ---------------- */

export function parseSituationsCSV(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  return result.data.map((r) => ({
    situation: (r.situation || r.Situation || "").trim(),
    level: (r.level || r.Level || "").trim().toUpperCase(),
    phrase: (r.phrase || r.Phrase || "").trim(),
    meaning: (r.meaning || r.Meaning || "").trim(),
    targetWord: (r.targetWord || r.target_word || r.TargetWord || "").trim(),
  }));
}

export function analyzeSituationRows(rows, existingSituations) {
  const existingSet = new Set((existingSituations || []).map((s) => norm(s.phrase)));
  const seenInBatch = new Set();
  return rows.map((r) => {
    const valid = !!(r.phrase && r.meaning);
    const key = norm(r.phrase);
    const duplicate = valid && (existingSet.has(key) || seenInBatch.has(key));
    if (valid) seenInBatch.add(key);
    return { ...r, __valid: valid, __duplicate: duplicate };
  });
}

/** Mirrors exportWordsCSV for situations - includes SRS progress fields,
 * not just the raw situation/phrase/meaning content. */
export function exportSituationsCSV(situations) {
  return Papa.unparse(
    situations.map((s) => ({
      situation: s.situation,
      level: s.level,
      phrase: s.phrase,
      meaning: s.meaning,
      targetWord: s.targetWord || "",
      repetition: s.repetition || 0,
      interval: s.interval || 0,
      ef: s.ef ?? 2.5,
      nextReview: s.nextReview || "",
    }))
  );
}

export async function downloadCSV(csvText, filename) {
  return exportTextFile(csvText, filename, "text/csv");
}
