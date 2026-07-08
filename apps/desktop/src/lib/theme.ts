/**
 * Hell/Dunkel/System. Gespeichert pro Gerät (localStorage), angewendet über data-theme auf <html>.
 * In der Desktop-App wird zusätzlich die Fensterleiste von Windows/macOS umgefärbt.
 */
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "kontor.theme";
const listeners = new Set<(m: ThemeMode) => void>();

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return media()?.matches ? "dark" : "light";
}

async function applyWindow(mode: ThemeMode) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {
    /* ältere Systeme: Titelleiste bleibt wie sie ist */
  }
}

export function applyTheme(mode = read()) {
  document.documentElement.dataset.theme = resolve(mode);
  void applyWindow(mode);
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* privater Modus o. ä. */
  }
  applyTheme(mode);
  listeners.forEach((l) => l(mode));
}

/** Einmal beim Start: Theme setzen und Systemwechsel verfolgen */
export function initTheme() {
  applyTheme();
  media()?.addEventListener("change", () => {
    if (read() === "system") applyTheme("system");
  });
}

export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(read);
  useEffect(() => {
    listeners.add(setMode);
    return () => {
      listeners.delete(setMode);
    };
  }, []);
  return [mode, setTheme];
}
