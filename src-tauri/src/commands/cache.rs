use anyhow::{anyhow, Context};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::runtime_assets;

const DEFAULT_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const CACHE_MARKER: &str = ".refmind3d-image-cache";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettingsFile { directory: String, max_bytes: u64, initialized: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    directory: String,
    size_bytes: u64,
    max_bytes: u64,
    initialized: bool,
    available: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImageCache { preview_url: String, thumbnail_url: String, cache_hit: bool }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheManifest {
    source_size: u64,
    source_modified_ms: u64,
    source_hash: u64,
    preview_file: String,
    thumbnail_file: String,
    last_accessed_ms: u64,
}

enum SourceLocation { File(PathBuf), Runtime(String), Memory(Vec<u8>) }
struct SourceDescriptor { location: SourceLocation, size: u64, modified: u64, hash: u64, extension: String }

fn state_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(env::temp_dir).join("RefMind3D")
}
fn default_settings() -> CacheSettingsFile {
    CacheSettingsFile { directory: state_dir().join("ImageCache").to_string_lossy().to_string(), max_bytes: DEFAULT_LIMIT_BYTES, initialized: false }
}
fn settings_path() -> PathBuf { state_dir().join("cache-settings.json") }
fn read_settings() -> CacheSettingsFile {
    fs::read(settings_path()).ok().and_then(|v| serde_json::from_slice(&v).ok()).map(|mut v: CacheSettingsFile| {
        if v.max_bytes == 0 { v.max_bytes = DEFAULT_LIMIT_BYTES; }
        v
    }).unwrap_or_else(default_settings)
}
fn write_settings(value: &CacheSettingsFile) -> anyhow::Result<()> {
    fs::create_dir_all(state_dir())?;
    fs::write(settings_path(), serde_json::to_vec_pretty(value)?)?;
    fs::write(state_dir().join("cache-directory.txt"), value.directory.as_bytes())?;
    Ok(())
}
fn initialize_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path).with_context(|| format!("无法创建缓存目录：{}", path.display()))?;
    let probe = path.join(format!(".write-test-{}", std::process::id()));
    fs::write(&probe, b"ok").with_context(|| format!("缓存目录不可写：{}", path.display()))?;
    let _ = fs::remove_file(probe);
    fs::write(path.join(CACHE_MARKER), b"RefMind3D persistent image cache\n")?;
    Ok(())
}
fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path).into_iter().filter_map(Result::ok).filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file()).map(|m| m.len()).sum()
}
fn status(value: &CacheSettingsFile) -> CacheStatus {
    let path = PathBuf::from(&value.directory);
    let result = initialize_dir(&path);
    CacheStatus { directory: value.directory.clone(), size_bytes: if result.is_ok() { dir_size(&path) } else { 0 }, max_bytes: value.max_bytes, initialized: value.initialized, available: result.is_ok(), error: result.err().map(|e| e.to_string()) }
}

#[tauri::command]
pub async fn image_cache_status() -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(|| status(&read_settings())).await.map_err(|e| format!("读取缓存状态失败：{e}"))
}

#[tauri::command]
pub async fn set_image_cache_directory(directory: String) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if directory.trim().is_empty() { return Err("请选择缓存目录".to_string()); }
        let path = PathBuf::from(directory.trim());
        initialize_dir(&path).map_err(|e| e.to_string())?;
        let mut value = read_settings();
        value.directory = path.to_string_lossy().to_string();
        value.initialized = true;
        write_settings(&value).map_err(|e| format!("保存缓存设置失败：{e}"))?;
        Ok(status(&value))
    }).await.map_err(|e| format!("设置缓存目录失败：{e}"))?
}

#[tauri::command]
pub async fn confirm_default_image_cache_directory() -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut value = read_settings();
        initialize_dir(Path::new(&value.directory)).map_err(|e| e.to_string())?;
        value.initialized = true;
        write_settings(&value).map_err(|e| e.to_string())?;
        Ok(status(&value))
    }).await.map_err(|e| format!("确认缓存目录失败：{e}"))?
}

#[tauri::command]
pub async fn clear_image_cache(older_than_days: Option<u64>) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = read_settings();
        let root = PathBuf::from(&value.directory);
        initialize_dir(&root).map_err(|e| e.to_string())?;
        let cutoff = older_than_days.map(|d| SystemTime::now().checked_sub(Duration::from_secs(d.saturating_mul(86_400))).unwrap_or(UNIX_EPOCH));
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.filter_map(Result::ok) {
            let path = entry.path();
            if path.file_name().and_then(|v| v.to_str()) == Some(CACHE_MARKER) { continue; }
            let remove = cutoff.map(|c| newest_modified(&path).map(|t| t < c).unwrap_or(true)).unwrap_or(true);
            if remove { let _ = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }; }
        }
        Ok(status(&value))
    }).await.map_err(|e| format!("清理缓存失败：{e}"))?
}

fn newest_modified(path: &Path) -> Option<SystemTime> {
    if path.is_file() { return fs::metadata(path).ok()?.modified().ok(); }
    WalkDir::new(path).into_iter().filter_map(Result::ok).filter_map(|e| e.metadata().ok()?.modified().ok()).max()
}

#[tauri::command]
pub async fn prepare_image_cache(project_cache_id: String, asset: Value) -> Result<PreparedImageCache, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_sync(&project_cache_id, &asset)).await
        .map_err(|e| format!("生成图片缓存任务失败：{e}"))?.map_err(|e| e.to_string())
}

fn prepare_sync(project_id: &str, asset: &Value) -> anyhow::Result<PreparedImageCache> {
    let settings = read_settings();
    let root = PathBuf::from(&settings.directory);
    initialize_dir(&root)?;
    let asset_id = safe(asset.get("id").and_then(Value::as_str).unwrap_or("image"));
    let dir = root.join(safe(project_id)).join(&asset_id);
    fs::create_dir_all(&dir)?;
    let manifest_path = dir.join("manifest.json");
    let source = describe_source(asset)?;
    let (size, modified, hash) = (source.size, source.modified, source.hash);
    if let Ok(raw) = fs::read(&manifest_path) {
        if let Ok(mut manifest) = serde_json::from_slice::<CacheManifest>(&raw) {
            let preview = dir.join(&manifest.preview_file);
            let thumb = dir.join(&manifest.thumbnail_file);
            if manifest.source_size == size && manifest.source_modified_ms == modified && manifest.source_hash == hash && preview.is_file() && thumb.is_file() {
                if now_ms().saturating_sub(manifest.last_accessed_ms) > 3_600_000 {
                    manifest.last_accessed_ms = now_ms();
                    let _ = fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?);
                }
                return Ok(register(&asset_id, project_id, &preview, &thumb, true));
            }
        }
    }
    let bytes = match source.location {
        SourceLocation::File(path) => fs::read(path)?,
        SourceLocation::Runtime(url) => runtime_assets::read_resource_url(&url).map_err(|e| anyhow!(e))?.0,
        SourceLocation::Memory(bytes) => bytes,
    };
    let image = decode(&bytes, &source.extension)?;
    let preview = dir.join("decoded-preview.png");
    let thumb = dir.join("thumbnail.png");
    write_png(&preview, resize(image.clone(), 2400))?;
    write_png(&thumb, resize(image, 512))?;
    let manifest = CacheManifest { source_size: size, source_modified_ms: modified, source_hash: hash, preview_file: "decoded-preview.png".into(), thumbnail_file: "thumbnail.png".into(), last_accessed_ms: now_ms() };
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    enforce_limit(&root, settings.max_bytes);
    Ok(register(&asset_id, project_id, &preview, &thumb, false))
}

fn describe_source(asset: &Value) -> anyhow::Result<SourceDescriptor> {
    for field in ["originalPath", "projectAssetPath", "previewPath"] {
        let Some(value) = asset.get(field).and_then(Value::as_str).filter(|v| !v.is_empty()) else { continue; };
        if runtime_assets::is_resource_url(value) {
            if let Some((size, modified)) = runtime_assets::resource_source_signature(value) {
                if modified > 0 {
                    return Ok(SourceDescriptor { location: SourceLocation::Runtime(value.to_string()), size, modified, hash: 0, extension: extension(value, asset) });
                }
            }
            let (bytes, _, name) = runtime_assets::read_resource_url(value).map_err(|e| anyhow!(e))?;
            return Ok(SourceDescriptor { size: bytes.len() as u64, modified: 0, hash: bytes_hash(&bytes), extension: extension(&name, asset), location: SourceLocation::Memory(bytes) });
        }
        let path = PathBuf::from(value);
        if path.is_file() {
            let metadata = fs::metadata(&path)?;
            let modified = metadata.modified().ok().and_then(time_ms).unwrap_or(0);
            return Ok(SourceDescriptor { location: SourceLocation::File(path), size: metadata.len(), modified, hash: 0, extension: extension(value, asset) });
        }
    }
    Err(anyhow!("找不到图片原始数据，请重新打开工程或重新导入图片"))
}

fn extension(name: &str, asset: &Value) -> String {
    Path::new(name).extension().and_then(|v| v.to_str()).or_else(|| asset.get("format").and_then(Value::as_str)).unwrap_or("png").to_ascii_lowercase()
}
fn decode(bytes: &[u8], ext: &str) -> anyhow::Result<DynamicImage> {
    if matches!(ext, "psd" | "psb") {
        let psd = psd::Psd::from_bytes(bytes).map_err(|e| anyhow!("PSD 解码失败：{e}"))?;
        let rgba = image::ImageBuffer::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or_else(|| anyhow!("PSD 像素数据无效"))?;
        Ok(DynamicImage::ImageRgba8(rgba))
    } else { image::load_from_memory(bytes).map_err(|e| anyhow!("图片解码失败：{e}")) }
}
fn resize(image: DynamicImage, max: u32) -> DynamicImage { let (w,h) = image.dimensions(); if w.max(h) <= max { image } else { image.thumbnail(max,max) } }
fn write_png(path: &Path, image: DynamicImage) -> anyhow::Result<()> { let mut out = Cursor::new(Vec::new()); image.write_to(&mut out, ImageFormat::Png)?; fs::write(path, out.into_inner()).with_context(|| format!("写入缓存失败：{}", path.display())) }
fn register(asset_id: &str, project_id: &str, preview: &Path, thumb: &Path, hit: bool) -> PreparedImageCache {
    let suffix = safe(project_id);
    PreparedImageCache {
        preview_url: runtime_assets::register_file_resource(asset_id, &format!("cachePreview:{suffix}"), "decoded-preview.png".into(), "image/png".into(), preview.to_path_buf()),
        thumbnail_url: runtime_assets::register_file_resource(asset_id, &format!("cacheThumbnail:{suffix}"), "thumbnail.png".into(), "image/png".into(), thumb.to_path_buf()), cache_hit: hit
    }
}
fn enforce_limit(root: &Path, limit: u64) {
    let mut files = WalkDir::new(root).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file() && e.file_name() != CACHE_MARKER).filter_map(|e| { let m=e.metadata().ok()?; Some((e.path().to_path_buf(),m.len(),m.modified().unwrap_or(UNIX_EPOCH))) }).collect::<Vec<_>>();
    let mut total: u64 = files.iter().map(|v| v.1).sum();
    files.sort_by_key(|v| v.2);
    for (path,size,_) in files { if total <= limit { break; } if fs::remove_file(path).is_ok() { total=total.saturating_sub(size); } }
}
fn safe(value: &str) -> String { let v: String=value.chars().filter(|c| c.is_ascii_alphanumeric()||*c=='-'||*c=='_').take(96).collect(); if v.is_empty(){"default".into()}else{v} }
fn bytes_hash(bytes: &[u8]) -> u64 { let mut h=DefaultHasher::new(); bytes.hash(&mut h); h.finish() }
fn now_ms() -> u64 { time_ms(SystemTime::now()).unwrap_or(0) }
fn time_ms(time: SystemTime) -> Option<u64> { time.duration_since(UNIX_EPOCH).ok().map(|v| v.as_millis() as u64) }
