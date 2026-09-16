use anyhow::{anyhow, Context};
use base64::Engine;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageEncoder, ImageReader, metadata::Orientation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::sync::{Mutex, OnceLock};
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
    size_calculated: bool,
    max_bytes: u64,
    initialized: bool,
    available: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImageCache { preview_url: String, medium_url: String, thumbnail_url: String, tile_urls: Vec<String>, tile_size: u32, tile_columns: u32, image_width: u32, image_height: u32, cache_hit: bool }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheManifest {
    source_size: u64,
    source_modified_ms: u64,
    source_hash: u64,
    preview_file: String,
    #[serde(default)]
    medium_file: Option<String>,
    thumbnail_file: String,
    #[serde(default)] tile_files: Vec<String>,
    #[serde(default)] tile_size: u32,
    #[serde(default)] tile_columns: u32,
    #[serde(default)] image_width: u32,
    #[serde(default)] image_height: u32,
    last_accessed_ms: u64,
}

enum SourceLocation { File(PathBuf), Runtime(String), Memory(Vec<u8>) }
struct SourceDescriptor { location: SourceLocation, size: u64, modified: u64, hash: u64, extension: String }

fn state_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(env::temp_dir).join("RefMind3D")
}
fn settings_path() -> PathBuf { state_dir().join("cache-settings.json") }
fn write_settings(value: &CacheSettingsFile) -> anyhow::Result<()> {
    fs::create_dir_all(state_dir())?;
    fs::write(settings_path(), serde_json::to_vec_pretty(value)?)?;
    fs::write(state_dir().join("cache-directory.txt"), value.directory.as_bytes())?;
    Ok(())
}
fn initialize_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path).with_context(|| format!("无法创建缓存目录：{}", path.display()))?;
    // Visible images prepare in parallel. A PID-only probe made every request
    // contend for the same Windows file and intermittently reported sharing
    // violations as an unwritable directory.
    let probe = path.join(format!(".write-test-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    fs::write(&probe, b"ok").with_context(|| format!("缓存目录不可写：{}", path.display()))?;
    let _ = fs::remove_file(probe);
    ensure_marker(path)?;
    Ok(())
}

fn ensure_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path).with_context(|| format!("CACHE_DIRECTORY_UNAVAILABLE: 无法创建缓存目录：{}", path.display()))?;
    ensure_marker(path).with_context(|| format!("CACHE_DIRECTORY_UNAVAILABLE: 缓存目录不可写：{}", path.display()))?;
    Ok(())
}

fn ensure_marker(path: &Path) -> anyhow::Result<()> {
    let marker = path.join(CACHE_MARKER);
    match fs::OpenOptions::new().write(true).create_new(true).open(marker) {
        Ok(mut file) => file.write_all(b"RefMind3D persistent image cache\n").map_err(Into::into),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn project_cache_dir(project_id: &str, directory: Option<&str>) -> PathBuf {
    directory.filter(|value| !value.trim().is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| state_dir().join("ImageCache").join(safe(project_id)))
}
fn dir_size(path: &Path) -> u64 {
    WalkDir::new(path).into_iter().filter_map(Result::ok).filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file()).map(|m| m.len()).sum()
}
fn status(project_id: &str, directory: Option<&str>, calculate_size: bool) -> CacheStatus {
    let path = project_cache_dir(project_id, directory);
    let result = initialize_dir(&path);
    if result.is_ok() { repair_cache_once(&path); }
    CacheStatus { directory: path.to_string_lossy().to_string(), size_bytes: if result.is_ok() && calculate_size { dir_size(&path) } else { 0 }, size_calculated: calculate_size && result.is_ok(), max_bytes: DEFAULT_LIMIT_BYTES, initialized: directory.is_some_and(|value| !value.trim().is_empty()), available: result.is_ok(), error: result.err().map(|e| e.to_string()) }
}

#[tauri::command]
pub async fn image_cache_status(project_cache_id: String, cache_directory: Option<String>, calculate_size: Option<bool>) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&project_cache_id, cache_directory.as_deref(), calculate_size.unwrap_or(false))).await.map_err(|e| format!("读取缓存状态失败：{e}"))
}

#[tauri::command]
pub async fn set_image_cache_directory(project_cache_id: String, directory: String) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if directory.trim().is_empty() { return Err("请选择缓存目录".to_string()); }
        let path = PathBuf::from(directory.trim());
        initialize_dir(&path).map_err(|e| e.to_string())?;
        let value = CacheSettingsFile { directory: path.to_string_lossy().to_string(), max_bytes: DEFAULT_LIMIT_BYTES, initialized: true };
        write_settings(&value).map_err(|e| format!("保存缓存设置失败：{e}"))?;
        Ok(status(&project_cache_id, Some(&value.directory), true))
    }).await.map_err(|e| format!("设置缓存目录失败：{e}"))?
}

#[tauri::command]
pub async fn confirm_default_image_cache_directory(project_cache_id: String) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = project_cache_dir(&project_cache_id, None);
        initialize_dir(&directory).map_err(|e| e.to_string())?;
        let value = CacheSettingsFile { directory: directory.to_string_lossy().to_string(), max_bytes: DEFAULT_LIMIT_BYTES, initialized: true };
        write_settings(&value).map_err(|e| e.to_string())?;
        Ok(status(&project_cache_id, Some(&value.directory), true))
    }).await.map_err(|e| format!("确认缓存目录失败：{e}"))?
}

#[tauri::command]
pub async fn clear_image_cache(project_cache_id: String, cache_directory: Option<String>, older_than_days: Option<u64>) -> Result<CacheStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_cache_dir(&project_cache_id, cache_directory.as_deref());
        initialize_dir(&root).map_err(|e| e.to_string())?;
        let cutoff = older_than_days.map(|d| SystemTime::now().checked_sub(Duration::from_secs(d.saturating_mul(86_400))).unwrap_or(UNIX_EPOCH));
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.filter_map(Result::ok) {
            let path = entry.path();
            if path.file_name().and_then(|v| v.to_str()) == Some(CACHE_MARKER) { continue; }
            let remove = cutoff.map(|c| newest_modified(&path).map(|t| t < c).unwrap_or(true)).unwrap_or(true);
            if remove { let _ = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }; }
        }
        let root_text = root.to_string_lossy().to_string();
        Ok(status(&project_cache_id, Some(&root_text), true))
    }).await.map_err(|e| format!("清理缓存失败：{e}"))?
}

fn newest_modified(path: &Path) -> Option<SystemTime> {
    if path.is_file() { return fs::metadata(path).ok()?.modified().ok(); }
    WalkDir::new(path).into_iter().filter_map(Result::ok).filter_map(|e| e.metadata().ok()?.modified().ok()).max()
}

#[tauri::command]
pub async fn prepare_image_cache(project_cache_id: String, cache_directory: Option<String>, asset: Value) -> Result<PreparedImageCache, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_sync(&project_cache_id, cache_directory.as_deref(), &asset)).await
        .map_err(|e| format!("生成图片缓存任务失败：{e}"))?.map_err(|e| e.to_string())
}

fn prepare_sync(project_id: &str, cache_directory: Option<&str>, asset: &Value) -> anyhow::Result<PreparedImageCache> {
    let requested_root = project_cache_dir(project_id, cache_directory);
    // A missing removable drive or a stale per-project path must never prevent
    // images from appearing. Preserve the configured path for the settings UI,
    // but transparently serve this session from the system cache until the user
    // chooses a writable location.
    let root = match ensure_dir(&requested_root) {
        Ok(()) => requested_root,
        Err(_) if cache_directory.is_some() => {
            let fallback = project_cache_dir(project_id, None);
            ensure_dir(&fallback)?;
            fallback
        }
        Err(error) => return Err(error),
    };
    repair_cache_once(&root);
    let source = describe_source(asset)?;
    let (size, modified, hash) = (source.size, source.modified, source.hash);
    let asset_id = safe(asset.get("id").and_then(Value::as_str).unwrap_or("image"));
    // A content-addressed directory lets repeated imports reuse the exact same
    // decoded files even when the asset records have different ids.
    let dir = root.join(format!("content-{:016x}-{}", hash, size));
    fs::create_dir_all(&dir)?;
    let manifest_path = dir.join("manifest.json");
    if let Ok(raw) = fs::read(&manifest_path) {
        if let Ok(mut manifest) = serde_json::from_slice::<CacheManifest>(&raw) {
            let preview = dir.join(&manifest.preview_file);
            let medium = manifest.medium_file.as_ref().map(|file| dir.join(file)).filter(|path| path.is_file());
            let thumb = dir.join(&manifest.thumbnail_file);
            if manifest.source_size == size && manifest.source_modified_ms == modified && manifest.source_hash == hash && preview.is_file() && thumb.is_file() {
                if now_ms().saturating_sub(manifest.last_accessed_ms) > 3_600_000 {
                    manifest.last_accessed_ms = now_ms();
                    let _ = fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?);
                }
                let tiles = manifest.tile_files.iter().map(|file| dir.join(file)).filter(|path| path.is_file()).collect::<Vec<_>>();
                return Ok(register(&asset_id, project_id, &preview, medium.as_deref(), &thumb, &tiles, manifest.tile_size, manifest.tile_columns, manifest.image_width, manifest.image_height, &format!("{}-{}-{}", size, modified, hash), true));
            }
        }
    }
    // Cache misses decode large source images. Serializing only this expensive
    // path prevents a newly opened board from saturating every CPU core and
    // making camera movement stutter; cache hits above remain fully parallel.
    static GENERATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _generate_guard = GENERATE_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let bytes = match source.location {
        SourceLocation::File(path) => fs::read(path)?,
        SourceLocation::Runtime(url) => runtime_assets::read_resource_url(&url).map_err(|e| anyhow!(e))?.0,
        SourceLocation::Memory(bytes) => bytes,
    };
    let (image, icc_profile) = decode(&bytes, &source.extension)?;
    let preview = dir.join("decoded-preview.png");
    let medium = dir.join("medium-preview.png");
    let thumb = dir.join("thumbnail.png");
    let (source_width, source_height) = image.dimensions();
    write_png(&preview, resize(image.clone(), 2400), icc_profile.as_deref())?;
    write_png(&medium, resize(image.clone(), 1200), icc_profile.as_deref())?;
    write_png(&thumb, resize(image.clone(), 512), icc_profile.as_deref())?;
    let tile_size = 1024;
    let tiled = source_width.max(source_height) > 4096;
    let pyramid = if tiled { resize(image, 8192) } else { DynamicImage::new_rgba8(1, 1) };
    let (image_width, image_height) = if tiled { pyramid.dimensions() } else { (0, 0) };
    let tile_columns = if tiled { image_width.div_ceil(tile_size) } else { 0 };
    let tile_rows = if tiled { image_height.div_ceil(tile_size) } else { 0 };
    let mut tile_files = Vec::new();
    for row in 0..tile_rows { for column in 0..tile_columns {
        let x = column * tile_size; let y = row * tile_size;
        let width = tile_size.min(image_width - x); let height = tile_size.min(image_height - y);
        let file = format!("tile-{row}-{column}.png");
        write_png(&dir.join(&file), pyramid.crop_imm(x, y, width, height), icc_profile.as_deref())?;
        tile_files.push(file);
    }}
    let manifest = CacheManifest { source_size: size, source_modified_ms: modified, source_hash: hash, preview_file: "decoded-preview.png".into(), medium_file: Some("medium-preview.png".into()), thumbnail_file: "thumbnail.png".into(), tile_files: tile_files.clone(), tile_size, tile_columns, image_width, image_height, last_accessed_ms: now_ms() };
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    enforce_limit_in_background(&root, DEFAULT_LIMIT_BYTES);
    let tiles = tile_files.iter().map(|file| dir.join(file)).collect::<Vec<_>>();
    Ok(register(&asset_id, project_id, &preview, Some(&medium), &thumb, &tiles, tile_size, tile_columns, image_width, image_height, &format!("{}-{}-{}", size, modified, hash), false))
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
            let hash = sampled_file_hash(&path, metadata.len()).unwrap_or(0);
            return Ok(SourceDescriptor { location: SourceLocation::File(path), size: metadata.len(), modified, hash, extension: extension(value, asset) });
        }
    }
    Err(anyhow!("找不到图片原始数据，请重新打开工程或重新导入图片"))
}

fn extension(name: &str, asset: &Value) -> String {
    Path::new(name).extension().and_then(|v| v.to_str()).or_else(|| asset.get("format").and_then(Value::as_str)).unwrap_or("png").to_ascii_lowercase()
}
fn decode(bytes: &[u8], ext: &str) -> anyhow::Result<(DynamicImage, Option<Vec<u8>>)> {
    if matches!(ext, "psd" | "psb") {
        let psd = psd::Psd::from_bytes(bytes).map_err(|e| anyhow!("PSD 解码失败：{e}"))?;
        let rgba = image::ImageBuffer::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or_else(|| anyhow!("PSD 像素数据无效"))?;
        Ok((DynamicImage::ImageRgba8(rgba), None))
    } else {
        let mut decoder = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
        let icc_profile = decoder.icc_profile().ok().flatten();
        let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
        let mut image = DynamicImage::from_decoder(decoder)?;
        image.apply_orientation(orientation);
        Ok((image, icc_profile))
    }
}
fn resize(image: DynamicImage, max: u32) -> DynamicImage { let (w,h) = image.dimensions(); if w.max(h) <= max { image } else { image.thumbnail(max,max) } }
fn write_png(path: &Path, image: DynamicImage, icc_profile: Option<&[u8]>) -> anyhow::Result<()> { let rgba = image.to_rgba8(); let (width, height) = rgba.dimensions(); let mut bytes = Vec::new(); { let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes); if let Some(profile) = icc_profile { encoder.set_icc_profile(profile.to_vec())?; } encoder.write_image(rgba.as_raw(), width, height, image::ExtendedColorType::Rgba8)?; } fs::write(path, bytes).with_context(|| format!("写入缓存失败：{}", path.display())) }
fn register(asset_id: &str, project_id: &str, preview: &Path, medium: Option<&Path>, thumb: &Path, tiles: &[PathBuf], tile_size: u32, tile_columns: u32, image_width: u32, image_height: u32, generation: &str, hit: bool) -> PreparedImageCache {
    let suffix = safe(project_id);
    // A regenerated image gets fingerprinted URLs. Drop older registrations for
    // this project/asset so long sessions do not retain stale cache entries.
    runtime_assets::remove_resource_fields(asset_id, &format!("cachePreview:{suffix}:"));
    runtime_assets::remove_resource_fields(asset_id, &format!("cacheMedium:{suffix}:"));
    runtime_assets::remove_resource_fields(asset_id, &format!("cacheThumbnail:{suffix}:"));
    PreparedImageCache {
        preview_url: runtime_assets::register_file_resource(asset_id, &format!("cachePreview:{suffix}:{generation}"), "decoded-preview.png".into(), "image/png".into(), preview.to_path_buf()),
        medium_url: runtime_assets::register_file_resource(asset_id, &format!("cacheMedium:{suffix}:{generation}"), "medium-preview.png".into(), "image/png".into(), medium.unwrap_or(preview).to_path_buf()),
        thumbnail_url: runtime_assets::register_file_resource(asset_id, &format!("cacheThumbnail:{suffix}:{generation}"), "thumbnail.png".into(), "image/png".into(), thumb.to_path_buf()),
        tile_urls: tiles.iter().enumerate().map(|(index, path)| runtime_assets::register_file_resource(asset_id, &format!("cacheTile:{suffix}:{generation}:{index}"), format!("tile-{index}.png"), "image/png".into(), path.clone())).collect(),
        tile_size, tile_columns, image_width, image_height, cache_hit: hit
    }
}
fn enforce_limit(root: &Path, limit: u64) {
    let Ok(entries) = fs::read_dir(root) else { return; };
    let mut units = entries.filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(CACHE_MARKER) { return None; }
        let size = if path.is_dir() { dir_size(&path) } else { entry.metadata().ok()?.len() };
        let last_accessed = if path.is_dir() {
            fs::read(path.join("manifest.json")).ok()
                .and_then(|raw| serde_json::from_slice::<CacheManifest>(&raw).ok())
                .map(|manifest| manifest.last_accessed_ms)
                .unwrap_or_else(|| newest_modified(&path).and_then(time_ms).unwrap_or(0))
        } else {
            entry.metadata().ok()?.modified().ok().and_then(time_ms).unwrap_or(0)
        };
        Some((path, size, last_accessed))
    }).collect::<Vec<_>>();
    let mut total: u64 = units.iter().map(|unit| unit.1).sum();
    units.sort_by_key(|unit| unit.2);
    for (path, size, _) in units {
        if total <= limit { break; }
        let removed = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if removed.is_ok() { total = total.saturating_sub(size); }
    }
}

fn sampled_file_hash(path: &Path, size: u64) -> anyhow::Result<u64> {
    let mut file = fs::File::open(path)?;
    let mut hasher = DefaultHasher::new();
    size.hash(&mut hasher);
    let mut buffer = vec![0u8; 64 * 1024];
    let read = file.read(&mut buffer)?;
    buffer[..read].hash(&mut hasher);
    if size > buffer.len() as u64 {
        file.seek(SeekFrom::End(-(buffer.len() as i64)))?;
        let read = file.read(&mut buffer)?;
        buffer[..read].hash(&mut hasher);
    }
    Ok(hasher.finish())
}

#[tauri::command]
pub fn migrate_image_cache(project_cache_id: String, from_directory: String, to_directory: String) -> Result<bool, String> {
    let from = project_cache_dir(&project_cache_id, Some(&from_directory));
    let to = project_cache_dir(&project_cache_id, Some(&to_directory));
    if from == to || !from.is_dir() { return Ok(false); }
    initialize_dir(&to).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for entry in WalkDir::new(&from).into_iter().filter_map(Result::ok) {
            let Ok(relative) = entry.path().strip_prefix(&from) else { continue; };
            if relative.as_os_str().is_empty() { continue; }
            let destination = to.join(relative);
            if entry.file_type().is_dir() {
                let _ = fs::create_dir_all(&destination);
            } else if !destination.exists() {
                if let Some(parent) = destination.parent() { let _ = fs::create_dir_all(parent); }
                let _ = fs::copy(entry.path(), destination);
            }
        }
    });
    Ok(true)
}

#[tauri::command]
pub async fn load_model_cover(project_cache_id: String, cache_directory: Option<String>, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_cache_dir(&project_cache_id, cache_directory.as_deref());
        ensure_dir(&root).map_err(|e| e.to_string())?;
        let path = root.join("model-covers").join(format!("{}.webp", safe(&key)));
        if !path.is_file() { return Ok(None); }
        Ok(Some(runtime_assets::register_file_resource(&format!("model-cover-{}", safe(&key)), "preview", "cover.webp".into(), "image/webp".into(), path)))
    }).await.map_err(|e| format!("读取模型封面失败：{e}"))?
}

#[tauri::command]
pub async fn save_model_cover(project_cache_id: String, cache_directory: Option<String>, key: String, data_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_cache_dir(&project_cache_id, cache_directory.as_deref());
        ensure_dir(&root).map_err(|e| e.to_string())?;
        let directory = root.join("model-covers");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let encoded = data_url.split_once(',').map(|(_, data)| data).ok_or_else(|| "模型封面数据无效".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| format!("模型封面解码失败：{e}"))?;
        let path = directory.join(format!("{}.webp", safe(&key)));
        let temporary = path.with_extension("webp.tmp");
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        Ok(runtime_assets::register_file_resource(&format!("model-cover-{}", safe(&key)), "preview", "cover.webp".into(), "image/webp".into(), path))
    }).await.map_err(|e| format!("保存模型封面失败：{e}"))?
}

fn repair_cache_once(root: &Path) {
    static REPAIRED_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let roots = REPAIRED_ROOTS.get_or_init(|| Mutex::new(HashSet::new()));
    if !roots.lock().unwrap().insert(root.to_path_buf()) { return; }
    let _ = repair_cache_units(root, 64);
}

fn repair_cache_units(root: &Path, limit: usize) -> usize {
    let Ok(entries) = fs::read_dir(root) else { return 0; };
    let mut removed = 0;
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.is_dir()).take(limit) {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.is_file() { continue; }
        let manifest = fs::read(&manifest_path).ok().and_then(|raw| serde_json::from_slice::<CacheManifest>(&raw).ok());
        let valid = manifest.is_some_and(|manifest| {
            path.join(manifest.preview_file).is_file()
                && path.join(manifest.thumbnail_file).is_file()
                && manifest.medium_file.is_none_or(|file| path.join(file).is_file())
        });
        if !valid && fs::remove_dir_all(&path).is_ok() { removed += 1; }
    }
    removed
}
fn safe(value: &str) -> String { let v: String=value.chars().filter(|c| c.is_ascii_alphanumeric()||*c=='-'||*c=='_').take(96).collect(); if v.is_empty(){"default".into()}else{v} }
fn bytes_hash(bytes: &[u8]) -> u64 { let mut h=DefaultHasher::new(); bytes.hash(&mut h); h.finish() }
fn now_ms() -> u64 { time_ms(SystemTime::now()).unwrap_or(0) }
fn time_ms(time: SystemTime) -> Option<u64> { time.duration_since(UNIX_EPOCH).ok().map(|v| v.as_millis() as u64) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_directory_checks_do_not_share_a_probe_file() {
        let root = env::temp_dir().join(format!("refmind3d-cache-test-{}", uuid::Uuid::new_v4()));
        let handles = (0..24).map(|_| {
            let path = root.clone();
            std::thread::spawn(move || initialize_dir(&path))
        }).collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("cache check thread panicked").expect("cache directory check failed");
        }
        assert!(root.join(CACHE_MARKER).is_file());
        assert_eq!(WalkDir::new(&root).into_iter().filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".write-test-")).count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_cache_directory_is_isolated_per_project() {
        assert_ne!(project_cache_dir("project-a", None), project_cache_dir("project-b", None));
        assert!(project_cache_dir("project-a", None).ends_with("project-a"));
    }

    #[test]
    fn prepared_image_is_reused_and_invalidated_when_source_changes() {
        let root = env::temp_dir().join(format!("refmind3d-cache-image-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("source.png");
        let cache = root.join("project-cache");
        fs::create_dir_all(&root).unwrap();
        DynamicImage::new_rgba8(64, 64).save(&source).unwrap();
        let asset = serde_json::json!({
            "id": "asset-1",
            "format": "png",
            "originalPath": source.to_string_lossy()
        });
        assert!(!prepare_sync("project-1", Some(cache.to_string_lossy().as_ref()), &asset).unwrap().cache_hit);
        assert!(WalkDir::new(&cache).into_iter().filter_map(Result::ok)
            .any(|entry| entry.file_name() == "medium-preview.png" && entry.path().is_file()));
        assert!(prepare_sync("project-1", Some(cache.to_string_lossy().as_ref()), &asset).unwrap().cache_hit);
        DynamicImage::new_rgba8(96, 80).save(&source).unwrap();
        assert!(!prepare_sync("project-1", Some(cache.to_string_lossy().as_ref()), &asset).unwrap().cache_hit);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn large_image_cache_is_split_into_tiles() {
        let root = env::temp_dir().join(format!("refmind3d-cache-tile-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("wide.png"); let cache = root.join("project-cache");
        fs::create_dir_all(&root).unwrap(); DynamicImage::new_rgba8(4100, 2).save(&source).unwrap();
        let asset = serde_json::json!({ "id": "wide", "format": "png", "originalPath": source.to_string_lossy() });
        let prepared = prepare_sync("project-tiles", Some(cache.to_string_lossy().as_ref()), &asset).unwrap();
        assert_eq!(prepared.tile_columns, 5); assert_eq!(prepared.tile_urls.len(), 5);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_limit_removes_complete_oldest_asset_directory() {
        let root = env::temp_dir().join(format!("refmind3d-cache-limit-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for (name, accessed) in [("old", 1), ("new", 2)] {
            let directory = root.join(name);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("payload.bin"), vec![0_u8; 100]).unwrap();
            let manifest = CacheManifest {
                source_size: 100,
                source_modified_ms: 1,
                source_hash: 0,
                preview_file: "payload.bin".into(),
                medium_file: None,
                thumbnail_file: "payload.bin".into(),
                tile_files: Vec::new(),
                tile_size: 0,
                tile_columns: 0,
                image_width: 0,
                image_height: 0,
                last_accessed_ms: accessed,
            };
            fs::write(directory.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
        let newer_size = dir_size(&root.join("new"));
        enforce_limit(&root, newer_size);
        assert!(!root.join("old").exists());
        assert!(root.join("new").is_dir());
        assert!(root.join("new").join("payload.bin").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_repair_removes_only_broken_managed_units() {
        let root = env::temp_dir().join(format!("refmind3d-cache-repair-test-{}", uuid::Uuid::new_v4()));
        let broken = root.join("broken-asset");
        let unrelated = root.join("user-folder");
        fs::create_dir_all(&broken).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(broken.join("manifest.json"), b"not-json").unwrap();
        fs::write(unrelated.join("keep.txt"), b"keep").unwrap();
        assert_eq!(repair_cache_units(&root, 64), 1);
        assert!(!broken.exists());
        assert!(unrelated.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
fn enforce_limit_in_background(root: &Path, limit: u64) {
    static LAST_CHECKS: OnceLock<Mutex<HashMap<PathBuf, SystemTime>>> = OnceLock::new();
    let checks = LAST_CHECKS.get_or_init(|| Mutex::new(HashMap::new()));
    let now = SystemTime::now();
    {
        let mut guard = checks.lock().unwrap();
        if guard.get(root).and_then(|last| now.duration_since(*last).ok()).is_some_and(|elapsed| elapsed < Duration::from_secs(60)) {
            return;
        }
        guard.insert(root.to_path_buf(), now);
    }
    let root = root.to_path_buf();
    std::thread::spawn(move || enforce_limit(&root, limit));
}
