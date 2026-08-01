use anyhow::anyhow;
use base64::Engine as _;
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

use crate::runtime_assets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedVideo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub original_path: String,
    pub project_asset_path: String,
    pub preview_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub embedded_data_url: Option<String>,
    pub embedded_preview_data_url: Option<String>,
    pub embedded_thumbnail_data_url: Option<String>,
    pub file_size: u64,
    pub format: String,
    pub imported_at: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
}

const VIDEO_FORMATS: &[&str] = &[
    "mp4", "avi", "mov", "mkv", "webm", "m4v", "wmv", "flv", "ogg", "ogv", "3gp",
];

#[tauri::command]
pub async fn import_video_asset(
    source_path: String,
    project_root: String,
) -> Result<ImportedVideo, String> {
    tauri::async_runtime::spawn_blocking(move || import_video_asset_sync(source_path, project_root))
        .await
        .map_err(|e| format!("Video import task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_runtime_video_asset(
    data_url: String,
    name_hint: String,
) -> Result<ImportedVideo, String> {
    tauri::async_runtime::spawn_blocking(move || import_video_data_url_sync(data_url, name_hint))
        .await
        .map_err(|e| format!("Runtime video registration task failed: {e}"))?
        .map_err(|e| e.to_string())
}

fn import_video_data_url_sync(
    data_url: String,
    name_hint: String,
) -> anyhow::Result<ImportedVideo> {
    let (bytes, mime) = decode_data_url(&data_url)?;
    let ext = PathBuf::from(&name_hint)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if !VIDEO_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported video format: .{}", ext));
    }
    let id = Uuid::new_v4().to_string();
    let name = sanitize_file_name(if name_hint.trim().is_empty() {
        "video"
    } else {
        &name_hint
    });
    let project_asset_path = runtime_assets::register_memory_resource(
        &id,
        "projectAssetPath",
        name.clone(),
        mime.unwrap_or_else(|| mime_for_video_ext(&ext).to_string()),
        bytes.clone(),
    );
    Ok(ImportedVideo {
        id,
        kind: "video".to_string(),
        name,
        original_path: name_hint,
        project_asset_path,
        preview_path: None,
        thumbnail_path: None,
        embedded_data_url: None,
        embedded_preview_data_url: None,
        embedded_thumbnail_data_url: None,
        file_size: bytes.len() as u64,
        format: ext,
        imported_at: Utc::now().to_rfc3339(),
        width: None,
        height: None,
        duration: None,
    })
}

fn import_video_asset_sync(
    source_path: String,
    _project_root: String,
) -> anyhow::Result<ImportedVideo> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(anyhow!("File does not exist: {}", source_path));
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();

    if !VIDEO_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported video format: .{}", ext));
    }

    let id = Uuid::new_v4().to_string();
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("video")
        .to_string();
    let file_size = fs::metadata(&source)?.len();
    let source_text = source.to_string_lossy().to_string();

    Ok(ImportedVideo {
        id,
        kind: "video".to_string(),
        name,
        original_path: source_text.clone(),
        project_asset_path: source_text,
        preview_path: None,
        thumbnail_path: None,
        embedded_data_url: None,
        embedded_preview_data_url: None,
        embedded_thumbnail_data_url: None,
        file_size,
        format: ext,
        imported_at: Utc::now().to_rfc3339(),
        width: None,
        height: None,
        duration: None,
    })
}

fn decode_data_url(data_url: &str) -> anyhow::Result<(Vec<u8>, Option<String>)> {
    let comma_index = data_url
        .find(',')
        .ok_or_else(|| anyhow!("Invalid file data"))?;
    let header = &data_url[..comma_index];
    let payload = &data_url[comma_index + 1..];
    if !header.starts_with("data:") || !header.contains("base64") {
        return Err(anyhow!("Content is not a base64 data URL"));
    }
    let mime = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| anyhow!("File base64 decode failed: {e}"))?;
    Ok((bytes, mime))
}

fn mime_for_video_ext(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogg" | "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "video".to_string()
    } else {
        trimmed
    }
}
