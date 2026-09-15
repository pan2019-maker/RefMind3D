use anyhow::{anyhow, Context};
use base64::Engine as _;
use chrono::Utc;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, metadata::Orientation};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, REFERER, USER_AGENT};
use serde::Serialize;
use serde_json::Value;
use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::runtime_assets;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
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
    pub width: u32,
    pub height: u32,
    pub channels: Option<u8>,
}

const DIRECT_WEB_FORMATS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "gif", "ico", "avif", "svg",
];
const IMAGE_FORMATS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "gif", "ico", "tif", "tiff", "tga", "dds", "hdr", "exr",
    "avif", "qoi", "psd", "psb", "svg",
];
const PREVIEW_MAX_SIDE: u32 = 2400;
const MAX_REMOTE_IMAGE_BYTES: u64 = 200 * 1024 * 1024;

#[tauri::command]
pub async fn import_clipboard_image_data_url(
    data_url: String,
    _project_root: Option<String>,
) -> Result<ImportedImage, String> {
    tauri::async_runtime::spawn_blocking(move || import_clipboard_image_data_url_sync(data_url))
        .await
        .map_err(|e| format!("Clipboard image import task failed: {e}"))?
        .map_err(|e| e.to_string())
}

fn import_clipboard_image_data_url_sync(data_url: String) -> anyhow::Result<ImportedImage> {
    import_data_url_as_runtime_image(data_url, None, String::new())
}

#[tauri::command]
pub async fn register_runtime_asset(
    data_url: String,
    name_hint: Option<String>,
) -> Result<ImportedImage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_data_url_as_runtime_image(data_url, name_hint, String::new())
    })
    .await
    .map_err(|e| format!("Runtime image registration task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn image_asset_to_data_url(asset: Value) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || image_asset_to_data_url_sync(&asset))
        .await
        .map_err(|e| format!("Image data extraction task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn copy_image_asset_to_clipboard(asset: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_image_asset_to_clipboard_sync(&asset))
        .await
        .map_err(|e| format!("Copy image task failed: {e}"))?
        .map_err(|e| e.to_string())
}

fn copy_image_asset_to_clipboard_sync(asset: &Value) -> anyhow::Result<()> {
    let data_url = image_asset_to_data_url_sync(asset)?;
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| anyhow!("Image data is invalid"))?;
    if !header.to_ascii_lowercase().contains(";base64") {
        return Err(anyhow!("This image format cannot be copied as a bitmap"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| anyhow!("Image data decode failed: {e}"))?;
    let rgba = image::load_from_memory(&bytes)
        .map_err(|e| anyhow!("Image decode failed: {e}"))?
        .to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| anyhow!("System clipboard is unavailable: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| anyhow!("Write image to system clipboard failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn import_remote_image_asset(
    source_url: String,
    referer: Option<String>,
) -> Result<ImportedImage, String> {
    import_remote_image_asset_async(source_url, referer)
        .await
        .map_err(|e| e.to_string())
}

async fn import_remote_image_asset_async(
    source_url: String,
    referer: Option<String>,
) -> anyhow::Result<ImportedImage> {
    let url = reqwest::Url::parse(&source_url).map_err(|e| anyhow!("Invalid image URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(anyhow!("Only http/https image URLs can be imported"));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    let mut errors = Vec::new();
    let mut candidates = candidates_from_url(&url);
    candidates.push(url.clone());
    for candidate in dedupe_urls(candidates) {
        match import_remote_candidate(
            &client,
            candidate.clone(),
            referer.as_deref(),
            &source_url,
            0,
        )
        .await
        {
            Ok(asset) => return Ok(asset),
            Err(error) => errors.push(format!("{}: {error}", candidate)),
        }
    }
    Err(anyhow!(
        "Remote image import failed. Try copying the image itself or pasting a screenshot.\n{}",
        errors.into_iter().take(4).collect::<Vec<_>>().join("\n")
    ))
}

async fn import_remote_candidate(
    client: &reqwest::Client,
    url: reqwest::Url,
    referer: Option<&str>,
    original_path: &str,
    depth: usize,
) -> anyhow::Result<ImportedImage> {
    if depth > 2 {
        return Err(anyhow!("Page nesting is too deep"));
    }
    let mut request = client
        .get(url.clone())
        .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 RefMind3D")
        .header(ACCEPT, "image/avif,image/webp,image/apng,image/svg+xml,image/*,text/html,application/xhtml+xml,*/*;q=0.8")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8");
    if let Some(referer) =
        referer.filter(|value| value.starts_with("http://") || value.starts_with("https://"))
    {
        request = request.header(REFERER, referer);
    } else if depth > 0 {
        request = request.header(REFERER, url.as_str());
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(anyhow!("download failed: HTTP {}", response.status()));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_REMOTE_IMAGE_BYTES {
            return Err(anyhow!(
                "image is too large: {:.1} MB",
                length as f64 / 1024.0 / 1024.0
            ));
        }
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string());
    let final_url = response.url().clone();
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
        return Err(anyhow!(
            "image is too large: {:.1} MB",
            bytes.len() as f64 / 1024.0 / 1024.0
        ));
    }
    if looks_like_html(content_type.as_deref(), &bytes) {
        let html = String::from_utf8_lossy(&bytes);
        let candidates = extract_image_urls_from_html(&html, &final_url);
        if candidates.is_empty() {
            return Err(anyhow!("returned HTML but no image URL was found"));
        }
        let mut errors = Vec::new();
        for candidate in dedupe_urls(candidates).into_iter().take(12) {
            match Box::pin(import_remote_candidate(
                client,
                candidate.clone(),
                Some(final_url.as_str()),
                original_path,
                depth + 1,
            ))
            .await
            {
                Ok(asset) => return Ok(asset),
                Err(error) => errors.push(format!("{}: {error}", candidate)),
            }
        }
        return Err(anyhow!(
            "page image candidates failed: {}",
            errors.into_iter().take(3).collect::<Vec<_>>().join(" | ")
        ));
    }
    let name_hint = file_name_from_url(final_url.as_str());
    import_bytes_as_runtime_image(
        bytes.to_vec(),
        content_type,
        name_hint,
        original_path.to_string(),
    )
}

fn import_data_url_as_runtime_image(
    data_url: String,
    name_hint: Option<String>,
    original_path: String,
) -> anyhow::Result<ImportedImage> {
    let comma_index = data_url
        .find(',')
        .ok_or_else(|| anyhow!("Invalid image data"))?;
    let header = &data_url[..comma_index];
    let payload = &data_url[comma_index + 1..];
    if !header.starts_with("data:") || !header.contains("base64") {
        return Err(anyhow!("Content is not a base64 data URL"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| anyhow!("Image base64 decode failed: {e}"))?;
    let content_type = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    import_bytes_as_runtime_image(bytes, content_type, name_hint, original_path)
}

fn import_bytes_as_runtime_image(
    bytes: Vec<u8>,
    content_type: Option<String>,
    name_hint: Option<String>,
    original_path: String,
) -> anyhow::Result<ImportedImage> {
    let id = Uuid::new_v4().to_string();
    let ext = detect_image_extension(&bytes, content_type.as_deref(), name_hint.as_deref());
    let decoded = if ext == "svg" {
        None
    } else {
        Some(decode_image_bytes_preview(&bytes, &ext)?)
    };
    let (width, height) = decoded
        .as_ref()
        .map(DynamicImage::dimensions)
        .unwrap_or((800, 600));
    let mime = mime_for_image_ext(&ext).to_string();
    let name = name_hint
        .map(|value| sanitize_file_name(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("image_{id}.{ext}"));
    let project_asset_path = runtime_assets::register_memory_resource(
        &id,
        "projectAssetPath",
        name.clone(),
        mime,
        bytes.clone(),
    );
    
    let (preview_path, thumbnail_path) = if let Some(ref decoded) = decoded {
        let thumb_img = limit_thumbnail_size(decoded);
        let thumb_png = encode_png(thumb_img)?;
        let t_path = runtime_assets::register_memory_resource(
            &id,
            "thumbnailPath",
            format!("thumbnail_{id}.png"),
            "image/png".to_string(),
            thumb_png,
        );

        let p_path = if DIRECT_WEB_FORMATS.contains(&ext.as_str()) {
            None
        } else {
            let preview = encode_png(decoded.clone())?;
            Some(runtime_assets::register_memory_resource(
                &id,
                "previewPath",
                format!("preview_{id}.png"),
                "image/png".to_string(),
                preview,
            ))
        };
        (p_path, Some(t_path))
    } else {
        (None, None)
    };

    Ok(ImportedImage {
        id: id.clone(),
        kind: "image".to_string(),
        name,
        original_path,
        project_asset_path,
        preview_path,
        thumbnail_path,
        embedded_data_url: None,
        embedded_preview_data_url: None,
        embedded_thumbnail_data_url: None,
        file_size: bytes.len() as u64,
        format: ext.to_string(),
        imported_at: Utc::now().to_rfc3339(),
        width,
        height,
        channels: Some(4),
    })
}

fn image_asset_to_data_url_sync(asset: &Value) -> anyhow::Result<String> {
    for field in [
        "embeddedDataUrl",
        "embeddedPreviewDataUrl",
        "embeddedThumbnailDataUrl",
    ] {
        if let Some(data_url) = asset
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("data:image/"))
        {
            return Ok(data_url.to_string());
        }
    }

    for field in [
        "previewPath",
        "thumbnailPath",
        "projectAssetPath",
        "originalPath",
    ] {
        let Some(path) = asset
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        if path.starts_with("data:image/") {
            return Ok(path.to_string());
        }
        if runtime_assets::is_resource_url(path) {
            let (bytes, mime, file_name) =
                runtime_assets::read_resource_url(path).map_err(|e| anyhow!("{e}"))?;
            return Ok(bytes_to_image_data_url(bytes, Some(mime), Some(file_name)));
        }
        if path.starts_with("http://") || path.starts_with("https://") {
            continue;
        }
        let file_path = PathBuf::from(path);
        if file_path.exists() && file_path.is_file() {
            let bytes = fs::read(&file_path)
                .with_context(|| format!("Read image file failed: {}", file_path.display()))?;
            let mime = mime_for_image_path(&file_path);
            return Ok(bytes_to_image_data_url(
                bytes,
                mime,
                file_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string),
            ));
        }
    }

    Err(anyhow!("Selected image data was not found. Re-import the image or reopen the project, then try AI analysis again."))
}

fn bytes_to_image_data_url(
    bytes: Vec<u8>,
    mime: Option<String>,
    file_name: Option<String>,
) -> String {
    let mime = mime
        .filter(|value| value.starts_with("image/"))
        .or_else(|| file_name.as_deref().map(mime_for_image_name))
        .unwrap_or_else(|| "image/png".to_string());
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn mime_for_image_path(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(mime_for_image_name)
}

fn mime_for_image_name(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or(name).to_ascii_lowercase();
    mime_for_image_ext(&ext).to_string()
}

#[tauri::command]
pub async fn import_image_asset(
    source_path: String,
    project_root: String,
) -> Result<ImportedImage, String> {
    tauri::async_runtime::spawn_blocking(move || import_image_asset_sync(source_path, project_root))
        .await
        .map_err(|e| format!("Image import task failed: {e}"))?
        .map_err(|e| e.to_string())
}

fn import_image_asset_sync(
    source_path: String,
    _project_root: String,
) -> anyhow::Result<ImportedImage> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(anyhow!("File does not exist: {}", source_path));
    }
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if !IMAGE_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported image format: .{}", ext));
    }

    let metadata = fs::metadata(&source)
        .with_context(|| format!("Read image metadata failed: {}", source.display()))?;
    let file_size = metadata.len();
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("image")
        .to_string();
    let id = Uuid::new_v4().to_string();

    let (width, height, preview_path, thumbnail_path, channels) = if ext == "svg" {
        (800, 600, None, None, None)
    } else {
        let decoded = decode_preview(&source, &ext)?;
        let (width, height) = decoded.dimensions();
        
        let thumb_img = limit_thumbnail_size(&decoded);
        let thumb_png = encode_png(thumb_img)?;
        let t_path = runtime_assets::register_memory_resource(
            &id,
            "thumbnailPath",
            format!("thumbnail_{id}.png"),
            "image/png".to_string(),
            thumb_png,
        );

        let preview_path = if DIRECT_WEB_FORMATS.contains(&ext.as_str()) {
            None
        } else {
            let png = encode_png(decoded)?;
            let p_path = runtime_assets::register_memory_resource(
                &id,
                "previewPath",
                format!("preview_{id}.png"),
                "image/png".to_string(),
                png,
            );
            Some(p_path)
        };
        (width, height, preview_path, Some(t_path), Some(4))
    };

    let source_text = source.to_string_lossy().to_string();
    Ok(ImportedImage {
        id,
        kind: "image".to_string(),
        name,
        original_path: source_text.clone(),
        project_asset_path: source_text,
        preview_path,
        thumbnail_path,
        embedded_data_url: None,
        embedded_preview_data_url: None,
        embedded_thumbnail_data_url: None,
        file_size,
        format: ext,
        imported_at: Utc::now().to_rfc3339(),
        width,
        height,
        channels,
    })
}

fn decode_preview(path: &Path, ext: &str) -> anyhow::Result<DynamicImage> {
    if ext == "psd" || ext == "psb" {
        let bytes = fs::read(path).with_context(|| "Read PSD/PSB file failed")?;
        return Ok(decode_psd_preview_or_placeholder(&bytes));
    }
    let mut decoder = ImageReader::open(path)?.with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)
        .with_context(|| format!("Image decode failed for preview: {}", path.display()))?;
    img.apply_orientation(orientation);
    Ok(limit_preview_size(img))
}

fn decode_image_bytes_preview(bytes: &[u8], ext: &str) -> anyhow::Result<DynamicImage> {
    if ext == "psd" || ext == "psb" {
        return Ok(decode_psd_preview_or_placeholder(bytes));
    }
    let mut decoder = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| anyhow!("Image decode failed: {e}"))?;
    img.apply_orientation(orientation);
    Ok(limit_preview_size(img))
}

fn decode_psd_preview_or_placeholder(bytes: &[u8]) -> DynamicImage {
    if let Ok(psd) = psd::Psd::from_bytes(bytes) {
        if let Some(buffer) = image::ImageBuffer::from_raw(psd.width(), psd.height(), psd.rgba()) {
            return limit_preview_size(DynamicImage::ImageRgba8(buffer));
        }
    }
    psd_placeholder(bytes)
}

fn psd_placeholder(bytes: &[u8]) -> DynamicImage {
    let (source_width, source_height) = psd_header_dimensions(bytes).unwrap_or((640, 480));
    let max_side = 900f32;
    let side = source_width.max(source_height).max(1) as f32;
    let scale = (max_side / side).min(1.0);
    let width = ((source_width as f32 * scale).round() as u32).clamp(96, 900);
    let height = ((source_height as f32 * scale).round() as u32).clamp(96, 900);
    let mut image = image::RgbaImage::from_pixel(width, height, image::Rgba([48, 48, 54, 255]));
    for y in 0..height {
        for x in 0..width {
            if (x / 16 + y / 16) % 2 == 0 {
                image.put_pixel(x, y, image::Rgba([58, 58, 66, 255]));
            }
        }
    }
    DynamicImage::ImageRgba8(image)
}

fn psd_header_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 26 || &bytes[0..4] != b"8BPS" {
        return None;
    }
    let height = u32::from_be_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
    let width = u32::from_be_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
    if width == 0 || height == 0 {
        None
    } else {
        Some((width, height))
    }
}

fn limit_preview_size(img: DynamicImage) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w <= PREVIEW_MAX_SIDE && h <= PREVIEW_MAX_SIDE {
        return img;
    }
    img.thumbnail(PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE)
}

const THUMBNAIL_MAX_SIDE: u32 = 360;

fn limit_thumbnail_size(img: &DynamicImage) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w <= THUMBNAIL_MAX_SIDE && h <= THUMBNAIL_MAX_SIDE {
        return img.clone();
    }
    img.thumbnail(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE)
}

fn encode_png(img: DynamicImage) -> anyhow::Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    img.write_to(&mut cursor, ImageFormat::Png)?;
    Ok(cursor.into_inner())
}

fn looks_like_html(content_type: Option<&str>, bytes: &[u8]) -> bool {
    let mime = content_type.unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("image/") && mime != "image/svg+xml" {
        return false;
    }
    if mime.contains("text/html") || mime.contains("application/xhtml") {
        return true;
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_ascii_lowercase();
    head.contains("<html") || head.contains("<!doctype html")
}

fn dedupe_urls(urls: Vec<reqwest::Url>) -> Vec<reqwest::Url> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for url in urls {
        let key = url.as_str().to_string();
        if seen.insert(key) {
            out.push(url);
        }
    }
    out
}

fn candidates_from_url(url: &reqwest::Url) -> Vec<reqwest::Url> {
    let mut candidates = Vec::new();
    if let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) {
        if host.contains("i.pinimg.com") {
            for size in ["236x", "474x", "564x", "736x"] {
                if url.path().contains(&format!("/{size}/")) {
                    if let Ok(candidate) = reqwest::Url::parse(
                        &url.as_str().replace(&format!("/{size}/"), "/originals/"),
                    ) {
                        candidates.push(candidate);
                    }
                }
            }
        }
    }
    for (_, value) in url.query_pairs() {
        let value = decode_urlish(&value);
        if value.starts_with("http://") || value.starts_with("https://") {
            if let Ok(candidate) = reqwest::Url::parse(&value) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

fn extract_image_urls_from_html(html: &str, base: &reqwest::Url) -> Vec<reqwest::Url> {
    let mut scored: Vec<(i32, reqwest::Url)> = Vec::new();
    let attrs = [
        ("data-original", 110),
        ("data-iurl", 110),
        ("data-objurl", 110),
        ("data-src", 100),
        ("data-lazy-src", 100),
        ("data-thumb", 80),
        ("srcset", 95),
        ("src", 90),
        ("content", 85),
        ("href", 35),
    ];
    for (attr, base_score) in attrs {
        for value in attr_values(html, attr) {
            if attr == "srcset" {
                for part in value
                    .split(',')
                    .map(|item| item.trim().split_whitespace().next().unwrap_or(""))
                {
                    push_candidate(&mut scored, part, base, base_score);
                }
            } else {
                push_candidate(&mut scored, &value, base, base_score);
            }
        }
    }
    for value in css_url_values(html) {
        push_candidate(&mut scored, &value, base, 75);
    }
    for value in http_urls_in_text(html) {
        push_candidate(&mut scored, &value, base, 55);
    }
    let decoded_html = decode_urlish(html);
    if decoded_html != html {
        for value in http_urls_in_text(&decoded_html) {
            push_candidate(&mut scored, &value, base, 55);
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    dedupe_urls(scored.into_iter().map(|(_, url)| url).collect())
}

fn push_candidate(
    scored: &mut Vec<(i32, reqwest::Url)>,
    raw: &str,
    base: &reqwest::Url,
    base_score: i32,
) {
    let clean = decode_urlish(raw);
    if clean.is_empty()
        || clean.starts_with("data:")
        || clean.starts_with("blob:")
        || clean.starts_with("javascript:")
    {
        return;
    }
    let candidate = if clean.starts_with("http://") || clean.starts_with("https://") {
        reqwest::Url::parse(&clean)
    } else {
        base.join(&clean)
    };
    let Ok(url) = candidate else {
        return;
    };
    let score = base_score + image_url_score(&url);
    if score >= 70 {
        scored.push((score, url));
    }
}

fn image_url_score(url: &reqwest::Url) -> i32 {
    let raw = url.as_str().to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let mut score = 0;
    if host.contains("i.pinimg.com") {
        score += 120;
    }
    if host.contains("bdimg.com") || host.contains("baidu.com") {
        score += 70;
    }
    if path.contains("/originals/") {
        score += 40;
    }
    if path.contains("/736x/") || path.contains("/564x/") {
        score += 20;
    }
    if matches!(
        Path::new(&path)
            .extension()
            .and_then(|value| value.to_str()),
        Some("jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "avif" | "svg")
    ) {
        score += 80;
    }
    if raw.contains("image")
        || raw.contains("img")
        || raw.contains("photo")
        || raw.contains("pic")
        || raw.contains("thumb")
    {
        score += 35;
    }
    score
}

fn attr_values(html: &str, attr: &str) -> Vec<String> {
    let mut values = Vec::new();
    let bytes = html.as_bytes();
    let needle = attr.as_bytes();
    let mut offset = 0usize;

    while offset + needle.len() <= bytes.len() {
        let matches_attribute = bytes[offset..offset + needle.len()].eq_ignore_ascii_case(needle);
        let has_left_boundary = offset == 0 || is_html_attribute_boundary(bytes[offset - 1]);
        if !matches_attribute || !has_left_boundary {
            offset += 1;
            continue;
        }

        let mut cursor = offset + needle.len();
        if cursor < bytes.len() && is_html_attribute_name_char(bytes[cursor]) {
            offset += 1;
            continue;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            offset += 1;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            break;
        }

        let (start, end) = if matches!(bytes[cursor], b'\'' | b'"') {
            let quote = bytes[cursor];
            let start = cursor + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != quote {
                end += 1;
            }
            (start, end)
        } else {
            let start = cursor;
            let mut end = start;
            while end < bytes.len() && !bytes[end].is_ascii_whitespace() && bytes[end] != b'>' {
                end += 1;
            }
            (start, end)
        };
        if start < end {
            values.push(html[start..end].to_string());
        }
        offset = end.saturating_add(1);
    }
    values
}

fn is_html_attribute_boundary(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'<' | b'/')
}

fn is_html_attribute_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':')
}

fn css_url_values(html: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut offset = 0usize;
    let lower = html.to_ascii_lowercase();
    while let Some(found) = lower[offset..].find("url(") {
        let start = offset + found + 4;
        if let Some(end) = html[start..].find(')') {
            values.push(
                html[start..start + end]
                    .trim()
                    .trim_matches(['"', '\''])
                    .to_string(),
            );
            offset = start + end + 1;
        } else {
            break;
        }
    }
    values
}

fn http_urls_in_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for marker in ["http://", "https://"] {
        let mut offset = 0usize;
        while let Some(found) = text[offset..].find(marker) {
            let start = offset + found;
            let mut end = start;
            for (idx, ch) in text[start..].char_indices() {
                if ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | '(' | ',') {
                    break;
                }
                end = start + idx + ch.len_utf8();
            }
            if end > start {
                urls.push(text[start..end].to_string());
            }
            offset = end.max(start + marker.len());
        }
    }
    urls
}

fn decode_urlish(value: &str) -> String {
    let mut clean = value
        .trim()
        .trim_matches(['"', '\''])
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("\\/", "/")
        .replace("\\u002F", "/")
        .replace("\\u002f", "/")
        .replace("\\u003A", ":")
        .replace("\\u003a", ":");
    for _ in 0..2 {
        let decoded = percent_decode(&clean);
        if decoded == clean {
            break;
        }
        clean = decoded;
    }
    clean
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn detect_image_extension(
    bytes: &[u8],
    content_type: Option<&str>,
    name_hint: Option<&str>,
) -> String {
    if let Some(ext) = content_type.and_then(extension_from_mime) {
        return ext.to_string();
    }
    if let Ok(format) = image::guess_format(bytes) {
        return match format {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Gif => "gif",
            ImageFormat::WebP => "webp",
            ImageFormat::Bmp => "bmp",
            ImageFormat::Ico => "ico",
            ImageFormat::Tiff => "tiff",
            ImageFormat::Tga => "tga",
            ImageFormat::Dds => "dds",
            ImageFormat::Hdr => "hdr",
            ImageFormat::OpenExr => "exr",
            ImageFormat::Avif => "avif",
            _ => "png",
        }
        .to_string();
    }
    if let Some(ext) = name_hint
        .and_then(|name| Path::new(name).extension())
        .and_then(|value| value.to_str())
    {
        return ext.to_lowercase();
    }
    "png".to_string()
}

fn extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/tiff" => Some("tiff"),
        "image/avif" => Some("avif"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

fn mime_for_image_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn file_name_from_url(value: &str) -> Option<String> {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back().map(|item| item.to_string()))
        })
        .filter(|name| !name.trim().is_empty() && name.contains('.'))
        .map(|name| sanitize_file_name(&name))
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
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attr_values_matches_exact_attribute_names() {
        let html = r#"<img data-src="lazy.png" src = "direct.png" data-lazy-src='other.png'>"#;

        assert_eq!(attr_values(html, "src"), vec!["direct.png"]);
        assert_eq!(attr_values(html, "data-src"), vec!["lazy.png"],);
    }

    #[test]
    fn attr_values_accepts_unquoted_attribute_values() {
        let html = "<img src=https://example.test/image.webp alt=reference>";

        assert_eq!(
            attr_values(html, "src"),
            vec!["https://example.test/image.webp"],
        );
    }
}
