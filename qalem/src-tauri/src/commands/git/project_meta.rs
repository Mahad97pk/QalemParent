//! # Project Metadata
//!
//! Helpers for reading and writing per-project metadata stored at
//! `.qalem/project.json`. Extracted out of the old git module since this
//! storage has no actual dependency on git.

/// Helper to load project metadata, applying migrations if needed.
pub(crate) fn load_project_metadata(
    project_path: &std::path::Path,
) -> crate::types::ProjectMetadata {
    let metadata_path = project_path.join(".qalem/project.json");
    let mut metadata: crate::types::ProjectMetadata = std::fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();

    // Apply migrations if needed and save the updated metadata
    if metadata.migrate() {
        let _ = save_project_metadata(project_path, &metadata);
    }

    metadata
}

/// Helper to save project metadata
pub(crate) fn save_project_metadata(
    project_path: &std::path::Path,
    metadata: &crate::types::ProjectMetadata,
) -> Result<(), String> {
    let qalem_dir = project_path.join(".qalem");
    if !qalem_dir.exists() {
        std::fs::create_dir_all(&qalem_dir).map_err(|e| e.to_string())?;
    }
    let metadata_path = qalem_dir.join("project.json");
    let json = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    std::fs::write(&metadata_path, json).map_err(|e| e.to_string())
}
