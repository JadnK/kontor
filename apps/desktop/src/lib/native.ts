import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  pdf: { name: "PDF-Dokument", extensions: ["pdf"] },
  xml: { name: "E-Rechnung (XML)", extensions: ["xml"] },
  json: { name: "JSON", extensions: ["json"] },
};

/**
 * Speichert eine Datei. In der Desktop-App per Windows-Speichern-Dialog,
 * im Browser (Entwicklung) als normaler Download. Gibt den Pfad zurück oder null bei Abbruch.
 */
export async function saveFile(blob: Blob, filename: string): Promise<string | null> {
  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return filename;
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const path = await save({ defaultPath: filename, filters: FILTERS[ext] ? [FILTERS[ext]] : [] });
  if (!path) return null;
  const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await invoke("write_file", { path, data });
  return path;
}

export async function openFile(path: string) {
  if (isTauri()) await openPath(path);
}

/** PDF im Standardprogramm öffnen: temporär speichern ist ohne fs-Plugin nicht möglich, daher Speichern + Öffnen */
export async function saveAndOpen(blob: Blob, filename: string): Promise<string | null> {
  const path = await saveFile(blob, filename);
  if (path && isTauri()) await openPath(path);
  return path;
}

/** Adresse im Standardbrowser öffnen (Bank-Login u. Ä.) */
export async function openExternal(url: string) {
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener");
}

/** Systembenachrichtigung (Windows-Infocenter). Gibt false zurück, wenn nicht erlaubt. */
export async function notify(title: string, body: string): Promise<boolean> {
  try {
    if (isTauri()) {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (!ok) return false;
      sendNotification({ title, body });
      return true;
    }
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}
