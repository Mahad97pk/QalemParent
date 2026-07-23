//! PTY spawning and external registration commands.

use super::{PtyInfo, PTY_REGISTRY};
use crate::errors::CommandError;

/// Register an externally-spawned PTY process (like dev servers from tauri-pty).
///
/// This allows the backend to track and kill PTY processes that weren't spawned
/// through the `spawn_pty` command. Essential for cleaning up dev servers when
/// windows are closed.
///
/// The `pty_id` should be unique (e.g., the PTY ID from tauri-pty or a timestamp).
#[tauri::command]
#[tracing::instrument]
pub fn register_external_pty(
    window_label: String,
    pid: u32,
    pty_id: u32,
    description: String,
    project_path: Option<String>,
) -> Result<(), CommandError> {
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        registry.insert(
            pty_id,
            PtyInfo {
                pid,
                window_label: window_label.clone(),
                project_path: project_path.clone(),
            },
        );
        tracing::info!(
            "Registered external PTY for window {}: pty_id={}, pid={}, project={:?}, desc={}",
            window_label,
            pty_id,
            pid,
            project_path,
            description
        );
        Ok(())
    } else {
        Err(("Failed to lock PTY registry".to_string()).into())
    }
}

/// Unregister an externally-spawned PTY process.
///
/// Called when the PTY exits normally (before window close) to keep the registry clean.
#[tauri::command]
#[tracing::instrument]
pub fn unregister_external_pty(pty_id: u32) -> Result<(), CommandError> {
    if let Ok(mut registry) = PTY_REGISTRY.lock() {
        if let Some(info) = registry.remove(&pty_id) {
            tracing::info!(
                "Unregistered external PTY: pty_id={}, pid={}, window={}",
                pty_id,
                info.pid,
                info.window_label
            );
        }
        Ok(())
    } else {
        Err(("Failed to lock PTY registry".to_string()).into())
    }
}
