use anyhow::{anyhow, Context};
use base64::Engine as _;
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

use crate::runtime_assets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub vertices: Option<u64>,
    pub faces: Option<u64>,
    pub materials: Option<u64>,
    pub textures: Option<u64>,
    pub file_size: u64,
    pub bbox: Option<[f32; 3]>,
    pub warning_level: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModel {
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
    pub stats: ModelStats,
}

const MODEL_FORMATS: &[&str] = &["obj", "fbx", "glb", "gltf"];
const LARGE_FACE_THRESHOLD: u64 = 1_000_000;
const EXTREME_FACE_THRESHOLD: u64 = 5_000_000;
const LARGE_FILE_THRESHOLD: u64 = 500 * 1024 * 1024;

#[tauri::command]
pub async fn inspect_model_asset(
    source_path: String,
    project_root: String,
) -> Result<ImportedModel, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_model_asset_sync(source_path, project_root)
    })
    .await
    .map_err(|e| format!("Model import task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_runtime_model_asset(
    data_url: String,
    name_hint: String,
) -> Result<ImportedModel, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_model_data_url_sync(data_url, name_hint))
        .await
        .map_err(|e| format!("Runtime model registration task failed: {e}"))?
        .map_err(|e| e.to_string())
}

fn inspect_model_data_url_sync(
    data_url: String,
    name_hint: String,
) -> anyhow::Result<ImportedModel> {
    let (bytes, mime) = decode_data_url(&data_url)?;
    let ext = PathBuf::from(&name_hint)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if !MODEL_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported model format: .{}", ext));
    }
    let id = Uuid::new_v4().to_string();
    let name = sanitize_file_name(if name_hint.trim().is_empty() {
        "model"
    } else {
        &name_hint
    });
    let project_asset_path = runtime_assets::register_memory_resource(
        &id,
        "projectAssetPath",
        name.clone(),
        mime.unwrap_or_else(|| mime_for_model_ext(&ext).to_string()),
        bytes.clone(),
    );
    let mut stats = ModelStats {
        vertices: None,
        faces: None,
        materials: None,
        textures: None,
        file_size: bytes.len() as u64,
        bbox: None,
        warning_level: if bytes.len() as u64 > LARGE_FILE_THRESHOLD { "large" } else { "unknown" }.to_string(),
        warnings: vec!["Model was imported from a drag/drop file payload and will be loaded from the project package after save.".to_string()],
    };
    if bytes.len() as u64 > LARGE_FILE_THRESHOLD {
        stats.warnings.push(
            "File is larger than 500MB; inline canvas preview is disabled for UI responsiveness."
                .to_string(),
        );
    }
    Ok(ImportedModel {
        id,
        kind: "model".to_string(),
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
        stats,
    })
}

fn inspect_model_asset_sync(
    source_path: String,
    _project_root: String,
) -> anyhow::Result<ImportedModel> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(anyhow!("File does not exist: {}", source_path));
    }

    let ext = source
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if !MODEL_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported model format: .{}", ext));
    }

    let id = Uuid::new_v4().to_string();
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("model")
        .to_string();
    let file_size = fs::metadata(&source)
        .with_context(|| format!("Read model metadata failed: {}", source.display()))?
        .len();
    let stats = inspect_stats(&source, &ext, file_size);
    let source_text = source.to_string_lossy().to_string();

    Ok(ImportedModel {
        id,
        kind: "model".to_string(),
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
        stats,
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

fn mime_for_model_ext(ext: &str) -> &'static str {
    match ext {
        "gltf" => "model/gltf+json",
        "glb" => "model/gltf-binary",
        "obj" => "text/plain",
        "fbx" => "application/octet-stream",
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
        "model".to_string()
    } else {
        trimmed
    }
}

fn inspect_stats(path: &Path, ext: &str, file_size: u64) -> ModelStats {
    let mut vertices = None;
    let mut faces = None;
    let mut materials = None;
    let mut warnings = Vec::new();

    if ext == "obj" {
        if let Ok((v, f)) = inspect_obj(path) {
            vertices = Some(v);
            faces = Some(f);
        }
    } else if ext == "gltf" || ext == "glb" {
        match gltf::Gltf::open(path) {
            Ok(doc) => {
                materials = Some(doc.materials().count() as u64);
                warnings.push(
                    "GLTF/GLB metadata was inspected without loading full buffers.".to_string(),
                );
            }
            Err(_) => warnings
                .push("GLTF/GLB metadata could not be read; preview may still work.".to_string()),
        }
    } else if ext == "fbx" {
        warnings.push(
            "FBX is kept as a file reference and loaded only in the dedicated preview.".to_string(),
        );
    }

    if file_size > LARGE_FILE_THRESHOLD {
        warnings.push(
            "File is larger than 500MB; inline canvas preview is disabled for UI responsiveness."
                .to_string(),
        );
    }

    let warning_level = match faces {
        Some(f) if f >= EXTREME_FACE_THRESHOLD => {
            warnings.push("Face count exceeds the extreme threshold.".to_string());
            "extreme"
        }
        Some(f) if f >= LARGE_FACE_THRESHOLD => {
            warnings.push("Face count is high; loading is protected.".to_string());
            "large"
        }
        None if file_size > LARGE_FILE_THRESHOLD => "large",
        None => "unknown",
        _ => "ok",
    }
    .to_string();

    ModelStats {
        vertices,
        faces,
        materials,
        textures: None,
        file_size,
        bbox: None,
        warning_level,
        warnings,
    }
}

fn inspect_obj(path: &Path) -> anyhow::Result<(u64, u64)> {
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut vertices = 0;
    let mut faces = 0;
    for line in reader.lines() {
        let line = line?;
        if line.starts_with("v ") {
            vertices += 1;
        } else if line.starts_with("f ") {
            faces += 1;
        }
    }
    Ok((vertices, faces))
}

#[tauri::command]
pub async fn convert_model_to_obj(
    source_path: String,
    output_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        convert_model_to_obj_sync(source_path, output_path)
    })
    .await
    .map_err(|e| format!("Model export task failed: {e}"))?
    .map_err(|e| e.to_string())
}

fn convert_model_to_obj_sync(source_path: String, output_path: String) -> anyhow::Result<String> {
    let source = PathBuf::from(&source_path);
    let output = PathBuf::from(&output_path);
    let ext = source
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if ext == "obj" {
        fs::copy(&source, &output).with_context(|| "OBJ copy export failed")?;
        return Ok(output.to_string_lossy().to_string());
    }

    let status = Command::new("assimp")
        .arg("export")
        .arg(&source)
        .arg(&output)
        .status()
        .with_context(|| "assimp command was not found")?;

    if status.success() {
        Ok(output.to_string_lossy().to_string())
    } else {
        Err(anyhow!("Model OBJ export failed"))
    }
}
