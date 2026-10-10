import { exportTextFile } from "./FileExportService.js";
/**
 * BackupService
 * -----------------------------------------------------------------------
 * Full JSON backup/restore - unlike the Dictionary tab's CSV export (which
 * only ever wrote word/meaning/example/category/level), this captures
 * everything: vocabulary with full SM-2 + bucket state, situations,
 * streak, and settings. That gap - a CSV "backup" silently losing all
 * review progress on restore - was the reason this exists.
 */
import { SCHEMA_VERSION, migrate } from "./StorageService.js";

export function exportBackupJSON(data) {
  return JSON.stringify({ ...data, __version: SCHEMA_VERSION, __exportedAt: new Date().toISOString(), __app: "حصيلتي (Hasila)", __author: "Angelos Onsy" }, null, 2);
}

export async function downloadBackup(data, filename = "hasila-backup.json") {
  return exportTextFile(exportBackupJSON(data), filename, "application/json");
}

/**
 * Validates and migrates a backup file's raw text contents.
 * Returns { ok: true, data } on success, or { ok: false, error } on any
 * problem - crucially, this NEVER touches the app's current data itself;
 * it's the caller's job to only replace state once ok === true, so a
 * corrupted or old-schema file can never wipe out what's already saved.
 */
export function parseBackup(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, error: "الملف ده مش JSON صالح." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "شكل الملف مش متوقع." };
  }
  if (!Array.isArray(parsed.words)) {
    return { ok: false, error: "الملف مفيهوش قائمة كلمات صالحة." };
  }
  try {
    const migrated = migrate(parsed);
    return { ok: true, data: migrated };
  } catch (e) {
    return { ok: false, error: "تعذرت قراءة الملف: " + e.message };
  }
}
