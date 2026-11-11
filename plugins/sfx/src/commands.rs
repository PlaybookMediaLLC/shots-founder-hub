use crate::{AppSounds, SfxPluginExt};

// Synchronous on purpose: Tauri runs sync commands in the order they arrive.
// As async commands, a quick play/stop/play (React StrictMode remounting the
// onboarding screen) could finish out of order and leave the music stopped.

#[tauri::command]
#[specta::specta]
pub fn play<R: tauri::Runtime>(app: tauri::AppHandle<R>, sfx: AppSounds) {
    app.sfx().play(sfx)
}

#[tauri::command]
#[specta::specta]
pub fn stop<R: tauri::Runtime>(app: tauri::AppHandle<R>, sfx: AppSounds) {
    app.sfx().stop(sfx)
}

#[tauri::command]
#[specta::specta]
pub fn set_volume<R: tauri::Runtime>(app: tauri::AppHandle<R>, sfx: AppSounds, volume: f32) {
    app.sfx().set_volume(sfx, volume)
}
