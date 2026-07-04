use std::{fs, path::PathBuf};
use tauri::Manager;

/// Sucht eine vorinstallierte Server-Konfiguration (kontor.json):
/// 1. neben der kontor.exe (für Rollouts per Netzlaufwerk / Softwareverteilung)
/// 2. im App-Konfigurationsordner (%APPDATA%\de.jadenk.kontor\kontor.json)
#[tauri::command]
fn read_preset(app: tauri::AppHandle) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("kontor.json"));
        }
    }
    if let Ok(dir) = app.path().app_config_dir() {
        candidates.push(dir.join("kontor.json"));
    }
    candidates.into_iter().find_map(|p| fs::read_to_string(p).ok())
}

/// Schreibt eine Datei an einen vom Nutzer im Speichern-Dialog gewählten Pfad.
#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| format!("Datei konnte nicht gespeichert werden: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![read_preset, write_file])
        .run(tauri::generate_context!())
        .expect("Kontor konnte nicht gestartet werden");
}
