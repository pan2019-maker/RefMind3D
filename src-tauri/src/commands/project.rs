use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::runtime_assets::{self, PackedResourceRegistration};

#[tauri::command]
pub fn force_close_window(window: tauri::Window) -> Result<(), String> {
    window.destroy().map_err(|error| error.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedResource {
    asset_id: String,
    field: String,
    file_name: String,
    #[serde(default)]
    mime: Option<String>,
    data_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledProjectFile {
    version: u32,
    file_type: String,
    project: Value,
    embedded_resources: Vec<EmbeddedResource>,
    bundled_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PackedResource {
    asset_id: String,
    field: String,
    file_name: String,
    mime: String,
    zip_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackedProjectFile {
    version: u32,
    file_type: String,
    project: Value,
    resources: Vec<PackedResource>,
    packed_at: String,
}

enum ResourceSource {
    Path(PathBuf),
    Bytes(Vec<u8>),
    Runtime { asset_id: String, field: String },
}

struct PackedResourceSource {
    meta: PackedResource,
    source: ResourceSource,
}

struct PathResource {
    asset_id: String,
    field: String,
    path: String,
}

#[tauri::command]
pub fn save_project(
    path: String,
    project: Value,
    _embed_resources: Option<bool>,
) -> Result<(), String> {
    save_packed_project(path, project)
}

#[tauri::command]
pub fn load_project(path: String, _extract_root: Option<String>) -> Result<Value, String> {
    let mut file = File::open(&path).map_err(|e| format!("Read project failed: {e}"))?;
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic)
        .map_err(|e| format!("Read project failed: {e}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Read project failed: {e}"))?;

    if magic == *b"PK" {
        return load_packed_project(file, &path);
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Read project failed: {e}"))?;
    let raw: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Project parse failed: {e}"))?;

    let is_bundled = raw
        .get("fileType")
        .and_then(Value::as_str)
        .map(|v| v == "refmind3d-bundled-workspace")
        .unwrap_or(false);

    if !is_bundled {
        return Ok(raw);
    }

    let bundled: BundledProjectFile =
        serde_json::from_value(raw).map_err(|e| format!("Bundled project parse failed: {e}"))?;
    let mut project = bundled.project;
    restore_embedded_resources_to_data_urls(&mut project, &bundled.embedded_resources);
    Ok(project)
}

#[tauri::command]
pub fn get_launch_project_path() -> Option<String> {
    env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        extension.eq_ignore_ascii_case("refmind3d")
                            || extension.eq_ignore_ascii_case("refmind")
                    })
                    .unwrap_or(false)
        })
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_project_data_url(data_url: String, name_hint: Option<String>) -> Result<Value, String> {
    let (_, bytes) = decode_data_url(&data_url)?;
    let dir = env::temp_dir().join("refmind3d-dropped-projects");
    fs::create_dir_all(&dir).map_err(|e| format!("Create temporary project folder failed: {e}"))?;
    let safe_name =
        sanitize_file_name(&name_hint.unwrap_or_else(|| "dropped.refmind3d".to_string()));
    let ext = Path::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("refmind3d");
    let path = dir.join(format!(
        "{}.{}",
        Uuid::new_v4(),
        if ext.eq_ignore_ascii_case("refmind") {
            "refmind"
        } else {
            "refmind3d"
        }
    ));
    fs::write(&path, bytes).map_err(|e| format!("Write temporary project package failed: {e}"))?;
    load_project(path.to_string_lossy().to_string(), None)
}

fn save_packed_project(path: String, mut project: Value) -> Result<(), String> {
    let mut sources = collect_packed_resources(&mut project)?;
    for item in &mut sources {
        if let ResourceSource::Runtime { asset_id, field } = &item.source {
            let (bytes, _, _) = runtime_assets::read_resource(asset_id, field).map_err(|e| {
                format!("Read runtime resource failed {}: {e}", item.meta.file_name)
            })?;
            item.source = ResourceSource::Bytes(bytes);
        }
    }
    let resources = sources
        .iter()
        .map(|item| item.meta.clone())
        .collect::<Vec<_>>();
    let packed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string());

    let manifest = PackedProjectFile {
        version: 2,
        file_type: "refmind3d-packed-workspace".to_string(),
        project,
        resources,
        packed_at,
    };

    let file = fs::File::create(&path).map_err(|e| format!("Create project file failed: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let manifest_text = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("Serialize project index failed: {e}"))?;
    zip.start_file("project.json", deflated)
        .map_err(|e| format!("Write project index failed: {e}"))?;
    zip.write_all(&manifest_text)
        .map_err(|e| format!("Write project index failed: {e}"))?;

    for item in sources {
        let options = SimpleFileOptions::default()
            .compression_method(compression_method_for_resource(&item.meta));
        zip.start_file(&item.meta.zip_path, options)
            .map_err(|e| format!("Write resource failed {}: {e}", item.meta.file_name))?;
        match item.source {
            ResourceSource::Path(path) => {
                let mut file = File::open(&path)
                    .map_err(|e| format!("Open resource failed {}: {e}", path.display()))?;
                std::io::copy(&mut file, &mut zip)
                    .map_err(|e| format!("Stream resource failed {}: {e}", path.display()))?;
            }
            ResourceSource::Bytes(bytes) => {
                zip.write_all(&bytes).map_err(|e| {
                    format!(
                        "Write embedded resource failed {}: {e}",
                        item.meta.file_name
                    )
                })?;
            }
            ResourceSource::Runtime { asset_id, field } => {
                let (bytes, _, _) =
                    runtime_assets::read_resource(&asset_id, &field).map_err(|e| {
                        format!("Read runtime resource failed {}: {e}", item.meta.file_name)
                    })?;
                zip.write_all(&bytes).map_err(|e| {
                    format!("Write runtime resource failed {}: {e}", item.meta.file_name)
                })?;
            }
        }
    }

    zip.finish()
        .map_err(|e| format!("Finish project package failed: {e}"))?;
    Ok(())
}

fn load_packed_project(file: File, project_path: &str) -> Result<Value, String> {
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Project package parse failed: {e}"))?;

    let mut manifest_text = String::new();
    archive
        .by_name("project.json")
        .map_err(|e| format!("Project package misses project.json: {e}"))?
        .read_to_string(&mut manifest_text)
        .map_err(|e| format!("Read project index failed: {e}"))?;

    let manifest: PackedProjectFile = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("Project index parse failed: {e}"))?;

    let mut path_resources = Vec::new();
    for resource in &manifest.resources {
        archive
            .by_name(&resource.zip_path)
            .map_err(|e| format!("Project resource missing {}: {e}", resource.file_name))?;
        let out_path = runtime_assets::register_packed_resource(
            project_path,
            &PackedResourceRegistration {
                asset_id: resource.asset_id.clone(),
                field: resource.field.clone(),
                file_name: resource.file_name.clone(),
                mime: resource.mime.clone(),
                zip_path: resource.zip_path.clone(),
            },
        );
        path_resources.push(PathResource {
            asset_id: resource.asset_id.clone(),
            field: resource.field.clone(),
            path: out_path,
        });
    }

    let mut project = manifest.project;
    patch_path_resources(&mut project, &path_resources);
    Ok(project)
}

fn collect_packed_resources(project: &mut Value) -> Result<Vec<PackedResourceSource>, String> {
    let mut sources = Vec::new();
    let mut used_paths = HashSet::new();

    if let Some(assets) = project.get_mut("assets").and_then(Value::as_array_mut) {
        collect_from_assets(assets, &mut sources, &mut used_paths)?;
    }
    if let Some(canvases) = project.get_mut("canvases").and_then(Value::as_array_mut) {
        for canvas in canvases {
            if let Some(assets) = canvas
                .get_mut("project")
                .and_then(|project| project.get_mut("assets"))
                .and_then(Value::as_array_mut)
            {
                collect_from_assets(assets, &mut sources, &mut used_paths)?;
            }
        }
    }

    Ok(sources)
}

fn collect_from_assets(
    assets: &mut [Value],
    sources: &mut Vec<PackedResourceSource>,
    used_paths: &mut HashSet<String>,
) -> Result<(), String> {
    for asset in assets {
        let asset_id = asset
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("asset")
            .to_string();
        let kind = asset
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let format = asset
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("bin")
            .to_string();
        let name = asset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("asset")
            .to_string();

        collect_asset_field(
            asset,
            sources,
            used_paths,
            &asset_id,
            &kind,
            &format,
            &name,
            "embeddedDataUrl",
            "projectAssetPath",
            "originalPath",
            "source",
        )?;
        collect_asset_field(
            asset,
            sources,
            used_paths,
            &asset_id,
            &kind,
            &format,
            &name,
            "embeddedPreviewDataUrl",
            "previewPath",
            "",
            "preview",
        )?;
        collect_asset_field(
            asset,
            sources,
            used_paths,
            &asset_id,
            &kind,
            &format,
            &name,
            "embeddedThumbnailDataUrl",
            "thumbnailPath",
            "",
            "thumbnail",
        )?;
        collect_document_media(asset, sources, used_paths, &asset_id)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_asset_field(
    asset: &mut Value,
    sources: &mut Vec<PackedResourceSource>,
    used_paths: &mut HashSet<String>,
    asset_id: &str,
    kind: &str,
    format: &str,
    name: &str,
    embedded_field: &str,
    path_field: &str,
    fallback_path_field: &str,
    role: &str,
) -> Result<(), String> {
    let mut source: Option<ResourceSource> = None;
    let mut mime: Option<String> = None;

    if let Some(data_url) = asset
        .get(embedded_field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let (data_mime, bytes) = decode_data_url(data_url)?;
        mime = Some(data_mime);
        source = Some(ResourceSource::Bytes(bytes));
    } else {
        let path = asset
            .get(path_field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                asset
                    .get(fallback_path_field)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
            });
        if let Some(path) = path {
            if let Some((resource_asset_id, resource_field)) =
                runtime_assets::parse_resource_url(path)
            {
                if let Ok((_, resource_mime, _)) =
                    runtime_assets::read_resource(&resource_asset_id, &resource_field)
                {
                    mime = Some(resource_mime);
                }
                source = Some(ResourceSource::Runtime {
                    asset_id: resource_asset_id,
                    field: resource_field,
                });
                if mime.is_none() {
                    mime = Some(mime_for_asset(kind, format));
                }
            } else {
                let source_path = PathBuf::from(path);
                if source_path.exists() && source_path.is_file() {
                    source = Some(ResourceSource::Path(source_path));
                    mime = Some(mime_for_asset(kind, format));
                }
            }
        }
    }

    let Some(source) = source else {
        return Ok(());
    };
    let mime = mime.unwrap_or_else(|| mime_for_asset(kind, format));
    let ext = extension_for_resource(kind, format, role, &mime);
    let clean_asset_id = sanitize_file_name(asset_id);
    let zip_path = unique_zip_path(
        &format!("assets/{}/{}.{}", clean_asset_id, role, ext),
        used_paths,
    );
    let file_name = if role == "source" {
        sanitize_file_name(name)
    } else {
        format!("{}.{}", role, ext)
    };

    let field = match role {
        "preview" => "previewPath",
        "thumbnail" => "thumbnailPath",
        _ => "projectAssetPath",
    }
    .to_string();

    sources.push(PackedResourceSource {
        meta: PackedResource {
            asset_id: asset_id.to_string(),
            field,
            file_name,
            mime,
            zip_path,
        },
        source,
    });

    if let Some(obj) = asset.as_object_mut() {
        obj.remove(embedded_field);
        obj.insert(path_field.to_string(), Value::String(String::new()));
        if role == "source" {
            obj.insert("originalPath".to_string(), Value::String(String::new()));
        }
    }

    Ok(())
}

fn collect_document_media(
    asset: &mut Value,
    sources: &mut Vec<PackedResourceSource>,
    used_paths: &mut HashSet<String>,
    asset_id: &str,
) -> Result<(), String> {
    let Some(media_items) = asset.get_mut("documentMedia").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for (index, media) in media_items.iter_mut().enumerate() {
        let media_id = media
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("media")
            .to_string();
        let field = format!("documentMedia:{media_id}");
        let name = media
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("media.bin")
            .to_string();
        let mime = media
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_string();
        let Some(path) = media
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let source = if let Some((resource_asset_id, resource_field)) =
            runtime_assets::parse_resource_url(path)
        {
            ResourceSource::Runtime {
                asset_id: resource_asset_id,
                field: resource_field,
            }
        } else {
            let source_path = PathBuf::from(path);
            if !source_path.exists() || !source_path.is_file() {
                continue;
            }
            ResourceSource::Path(source_path)
        };
        let file_name = sanitize_file_name(&name);
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("bin");
        let clean_asset_id = sanitize_file_name(asset_id);
        let zip_path = unique_zip_path(
            &format!(
                "assets/{}/document-media/{:03}.{}",
                clean_asset_id,
                index + 1,
                ext
            ),
            used_paths,
        );
        sources.push(PackedResourceSource {
            meta: PackedResource {
                asset_id: asset_id.to_string(),
                field,
                file_name,
                mime,
                zip_path,
            },
            source,
        });
        if let Some(obj) = media.as_object_mut() {
            obj.insert("path".to_string(), Value::String(String::new()));
        }
    }
    Ok(())
}

fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "Resource data URL is invalid".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Resource data URL decode failed: {e}"))?;
    Ok((mime, bytes))
}

fn restore_embedded_resources_to_data_urls(project: &mut Value, resources: &[EmbeddedResource]) {
    if let Some(assets) = project.get_mut("assets").and_then(Value::as_array_mut) {
        restore_embedded_assets(assets, resources);
    }
    if let Some(canvases) = project.get_mut("canvases").and_then(Value::as_array_mut) {
        for canvas in canvases {
            if let Some(assets) = canvas
                .get_mut("project")
                .and_then(|p| p.get_mut("assets"))
                .and_then(Value::as_array_mut)
            {
                restore_embedded_assets(assets, resources);
            }
        }
    }
}

fn restore_embedded_assets(assets: &mut [Value], resources: &[EmbeddedResource]) {
    for asset in assets {
        let Some(asset_id) = asset
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
        else {
            continue;
        };
        for resource in resources.iter().filter(|item| item.asset_id == asset_id) {
            let target_field = match resource.field.as_str() {
                "previewPath" => "embeddedPreviewDataUrl",
                "thumbnailPath" => "embeddedThumbnailDataUrl",
                _ => "embeddedDataUrl",
            };
            let mime = legacy_embedded_resource_mime(asset, resource);
            if let Some(obj) = asset.as_object_mut() {
                obj.insert(
                    target_field.to_string(),
                    Value::String(format!("data:{};base64,{}", mime, resource.data_base64)),
                );
            }
        }
    }
}

fn legacy_embedded_resource_mime(asset: &Value, resource: &EmbeddedResource) -> String {
    if let Some(mime) = resource
        .mime
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return mime.to_string();
    }

    // Legacy preview and thumbnail payloads were generated as PNG files.
    if matches!(resource.field.as_str(), "previewPath" | "thumbnailPath") {
        return "image/png".to_string();
    }

    let kind = asset.get("kind").and_then(Value::as_str).unwrap_or("");
    let format = asset.get("format").and_then(Value::as_str).unwrap_or("");
    let asset_mime = mime_for_asset(kind, format);
    if asset_mime != "application/octet-stream" {
        return asset_mime;
    }

    mime_from_file_name(&resource.file_name)
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

fn mime_from_file_name(file_name: &str) -> Option<String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => return None,
    };
    Some(mime.to_string())
}

fn patch_path_resources(project: &mut Value, resources: &[PathResource]) {
    if let Some(assets) = project.get_mut("assets").and_then(Value::as_array_mut) {
        patch_path_assets(assets, resources);
    }
    if let Some(canvases) = project.get_mut("canvases").and_then(Value::as_array_mut) {
        for canvas in canvases {
            if let Some(assets) = canvas
                .get_mut("project")
                .and_then(|p| p.get_mut("assets"))
                .and_then(Value::as_array_mut)
            {
                patch_path_assets(assets, resources);
            }
        }
    }
}

fn patch_path_assets(assets: &mut [Value], resources: &[PathResource]) {
    for asset in assets {
        let Some(asset_id) = asset
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
        else {
            continue;
        };
        for resource in resources.iter().filter(|item| item.asset_id == asset_id) {
            if let Some(obj) = asset.as_object_mut() {
                if let Some(media_id) = resource.field.strip_prefix("documentMedia:") {
                    if let Some(media_items) =
                        obj.get_mut("documentMedia").and_then(Value::as_array_mut)
                    {
                        for media in media_items {
                            if media.get("id").and_then(Value::as_str) == Some(media_id) {
                                if let Some(media_obj) = media.as_object_mut() {
                                    media_obj.insert(
                                        "path".to_string(),
                                        Value::String(resource.path.clone()),
                                    );
                                }
                            }
                        }
                    }
                } else {
                    obj.remove("embeddedDataUrl");
                    obj.remove("embeddedPreviewDataUrl");
                    obj.remove("embeddedThumbnailDataUrl");
                    obj.insert(resource.field.clone(), Value::String(resource.path.clone()));
                    if resource.field == "projectAssetPath" {
                        obj.insert(
                            "originalPath".to_string(),
                            Value::String(resource.path.clone()),
                        );
                    }
                }
            }
        }
    }
}

fn mime_for_asset(kind: &str, format: &str) -> String {
    match kind {
        "image" => match format {
            "jpg" | "jpeg" => "image/jpeg".to_string(),
            "png" => "image/png".to_string(),
            "webp" => "image/webp".to_string(),
            "gif" => "image/gif".to_string(),
            "bmp" => "image/bmp".to_string(),
            "ico" => "image/x-icon".to_string(),
            "svg" => "image/svg+xml".to_string(),
            other => format!("image/{}", other),
        },
        "model" => match format {
            "obj" => "model/obj".to_string(),
            "fbx" => "model/fbx".to_string(),
            "glb" => "model/glb".to_string(),
            "gltf" => "model/gltf".to_string(),
            _ => "application/octet-stream".to_string(),
        },
        "video" => match format {
            "mp4" | "m4v" => "video/mp4".to_string(),
            "webm" => "video/webm".to_string(),
            "ogg" | "ogv" => "video/ogg".to_string(),
            "mov" => "video/quicktime".to_string(),
            "avi" => "video/x-msvideo".to_string(),
            "mkv" => "video/x-matroska".to_string(),
            _ => "application/octet-stream".to_string(),
        },
        "pdf" => "application/pdf".to_string(),
        "table" => match format {
            "csv" => "text/csv".to_string(),
            "tsv" => "text/tab-separated-values".to_string(),
            "xls" => "application/vnd.ms-excel".to_string(),
            "xlsx" => {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()
            }
            _ => "application/octet-stream".to_string(),
        },
        "document" => match format {
            "txt" => "text/plain".to_string(),
            "md" => "text/markdown".to_string(),
            "rtf" => "application/rtf".to_string(),
            "doc" => "application/msword".to_string(),
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                .to_string(),
            _ => "application/octet-stream".to_string(),
        },
        _ => "application/octet-stream".to_string(),
    }
}

fn extension_for_resource(kind: &str, format: &str, role: &str, mime: &str) -> String {
    if role == "preview" || role == "thumbnail" {
        return "png".to_string();
    }
    let clean = format.trim().trim_start_matches('.').to_lowercase();
    if !clean.is_empty() && clean != "unknown" {
        return sanitize_file_name(&clean);
    }
    match mime {
        "image/jpeg" => "jpg".to_string(),
        "image/png" => "png".to_string(),
        "image/webp" => "webp".to_string(),
        "image/gif" => "gif".to_string(),
        "image/svg+xml" => "svg".to_string(),
        "video/mp4" => "mp4".to_string(),
        "model/obj" => "obj".to_string(),
        "model/fbx" => "fbx".to_string(),
        "model/glb" => "glb".to_string(),
        "model/gltf" => "gltf".to_string(),
        "application/pdf" => "pdf".to_string(),
        _ => match kind {
            "image" => "img".to_string(),
            "model" => "model".to_string(),
            "video" => "video".to_string(),
            "document" => "doc".to_string(),
            "table" => "table".to_string(),
            _ => "bin".to_string(),
        },
    }
}

fn compression_method_for_resource(resource: &PackedResource) -> CompressionMethod {
    let ext = resource
        .file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let already_compressed = matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "webp"
            | "gif"
            | "ico"
            | "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "wmv"
            | "flv"
            | "3gp"
            | "glb"
            | "pdf"
            | "docx"
            | "xlsx"
            | "zip"
            | "rar"
            | "7z"
            | "dds"
            | "avif"
            | "exr"
    );
    if already_compressed {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    }
}

fn unique_zip_path(path: &str, used_paths: &mut HashSet<String>) -> String {
    if used_paths.insert(path.to_string()) {
        return path.to_string();
    }
    let (stem, ext) = path
        .rsplit_once('.')
        .map(|(stem, ext)| (stem.to_string(), format!(".{}", ext)))
        .unwrap_or_else(|| (path.to_string(), String::new()));
    for index in 2.. {
        let candidate = format!("{}_{}{}", stem, index, ext);
        if used_paths.insert(candidate.clone()) {
            return candidate;
        }
    }
    path.to_string()
}

#[tauri::command]
pub fn save_png_data_url(path: String, data_url: String) -> Result<(), String> {
    let prefix = "data:image/png;base64,";
    let payload = data_url.strip_prefix(prefix).unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("PNG data decode failed: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("Export image failed: {e}"))
}

#[tauri::command]
pub fn save_data_url_to_path(path: String, data_url: String) -> Result<(), String> {
    let payload = data_url
        .split_once(',')
        .map(|(_, body)| body)
        .unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Resource data decode failed: {e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create export dir failed: {e}"))?;
    }
    fs::write(path, bytes).map_err(|e| format!("Export resource failed: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileItem {
    pub source_path: String,
    pub file_name: String,
}

#[tauri::command]
pub fn copy_file_to_path(source_path: String, output_path: String) -> Result<(), String> {
    if runtime_assets::is_resource_url(&source_path) {
        let (bytes, _, _) = runtime_assets::read_resource_url(&source_path)?;
        if let Some(parent) = Path::new(&output_path).parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Create export dir failed: {e}"))?;
        }
        return fs::write(output_path, bytes).map_err(|e| format!("Export resource failed: {e}"));
    }
    let source = Path::new(&source_path);
    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source.display()));
    }
    if let Some(parent) = Path::new(&output_path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Create export dir failed: {e}"))?;
    }
    fs::copy(source, output_path)
        .map(|_| ())
        .map_err(|e| format!("Export original failed: {e}"))
}

#[tauri::command]
pub fn export_files_to_folder(
    items: Vec<ExportFileItem>,
    output_dir: String,
) -> Result<usize, String> {
    let out_dir = Path::new(&output_dir);
    fs::create_dir_all(out_dir).map_err(|e| format!("Create export dir failed: {e}"))?;
    let mut exported = 0usize;
    for item in items {
        if runtime_assets::is_resource_url(&item.source_path) {
            let (bytes, _, _) = runtime_assets::read_resource_url(&item.source_path)?;
            let file_name = sanitize_file_name(&item.file_name);
            let mut target = out_dir.join(&file_name);
            if target.exists() {
                let stem = Path::new(&file_name)
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .unwrap_or("export");
                let ext = Path::new(&file_name)
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("");
                for index in 2.. {
                    let candidate = if ext.is_empty() {
                        out_dir.join(format!("{} ({})", stem, index))
                    } else {
                        out_dir.join(format!("{} ({}).{}", stem, index, ext))
                    };
                    if !candidate.exists() {
                        target = candidate;
                        break;
                    }
                }
            }
            fs::write(&target, bytes).map_err(|e| format!("Export {} failed: {e}", file_name))?;
            exported += 1;
            continue;
        }
        let source = Path::new(&item.source_path);
        if !source.exists() {
            continue;
        }
        let file_name = sanitize_file_name(&item.file_name);
        let mut target = out_dir.join(&file_name);
        if target.exists() {
            let stem = Path::new(&file_name)
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or("export");
            let ext = Path::new(&file_name)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("");
            for index in 2.. {
                let candidate = if ext.is_empty() {
                    out_dir.join(format!("{} ({})", stem, index))
                } else {
                    out_dir.join(format!("{} ({}).{}", stem, index, ext))
                };
                if !candidate.exists() {
                    target = candidate;
                    break;
                }
            }
        }
        fs::copy(source, &target).map_err(|e| format!("Export {} failed: {e}", file_name))?;
        exported += 1;
    }
    Ok(exported)
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "exported_asset".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_resource_uses_the_asset_image_format() {
        let asset = json!({ "kind": "image", "format": "jpg" });
        let resource = EmbeddedResource {
            asset_id: "asset-1".to_string(),
            field: "projectAssetPath".to_string(),
            file_name: "reference.jpg".to_string(),
            mime: None,
            data_base64: "AA==".to_string(),
        };

        assert_eq!(
            legacy_embedded_resource_mime(&asset, &resource),
            "image/jpeg"
        );
    }

    #[test]
    fn legacy_preview_resource_is_png_even_when_original_is_psd() {
        let asset = json!({ "kind": "image", "format": "psd" });
        let resource = EmbeddedResource {
            asset_id: "asset-1".to_string(),
            field: "previewPath".to_string(),
            file_name: "preview.png".to_string(),
            mime: None,
            data_base64: "AA==".to_string(),
        };

        assert_eq!(
            legacy_embedded_resource_mime(&asset, &resource),
            "image/png"
        );
    }
}
