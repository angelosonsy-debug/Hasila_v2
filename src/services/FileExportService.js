/**
 * FileExportService
 * -----------------------------------------------------------------------
 * Saves/shares a text file. `<a download>` does NOT work inside a
 * Capacitor Android WebView, so on native we write the file to the cache
 * directory and open the system share sheet (save to Drive/Files, send,
 * etc.). On the web we use a Blob + anchor.
 */
export async function exportTextFile(text, filename, mimeType = "text/plain") {
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  if (isNative) {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
    await Share.share({ title: filename, url: uri, dialogTitle: "حفظ / مشاركة الملف" });
    return true;
  }
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
