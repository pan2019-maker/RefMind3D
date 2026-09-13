use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use std::sync::{Mutex, OnceLock};

use tauri::http;
use zip::ZipArchive;

#[derive(Clone)]
pub enum ResourceBacking {
    Memory(Vec<u8>),
    File(PathBuf),
    Packed {
        package_path: String,
        zip_path: String,
    },
}

#[derive(Clone)]
pub struct RuntimeResource {
    pub file_name: String,
    pub mime: String,
    pub backing: ResourceBacking,
}

#[derive(Clone)]
pub struct PackedResourceRegistration {
    pub asset_id: String,
    pub field: String,
    pub file_name: String,
    pub mime: String,
    pub zip_path: String,
}

static RESOURCES: OnceLock<Mutex<HashMap<String, RuntimeResource>>> = OnceLock::new();

fn resources() -> &'static Mutex<HashMap<String, RuntimeResource>> {
    RESOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(asset_id: &str, field: &str) -> String {
    format!("{asset_id}::{field}")
}

fn encode_field(field: &str) -> String {
    field.replace(':', "%3A")
}

fn decode_field(field: &str) -> String {
    field.replace("%3A", ":")
}

pub fn resource_url(asset_id: &str, field: &str) -> String {
    format!(
        "http://refmind3d.localhost/resource/{}/{}",
        asset_id,
        encode_field(field)
    )
}

pub fn is_resource_url(value: &str) -> bool {
    parse_resource_url(value).is_some()
}

pub fn parse_resource_url(value: &str) -> Option<(String, String)> {
    let rest = if let Some(rest) = value.strip_prefix("refmind3d://resource/") {
        rest
    } else if let Some(rest) = value.strip_prefix("http://refmind3d.localhost/resource/") {
        rest
    } else if let Some(rest) = value.strip_prefix("https://refmind3d.localhost/resource/") {
        rest
    } else if let Some(index) = value.find("/resource/") {
        &value[index + "/resource/".len()..]
    } else {
        return None;
    };
    let mut parts = rest.split('/');
    let asset_id = parts.next()?.trim();
    let field = parts.next()?.trim();
    if asset_id.is_empty() || field.is_empty() {
        return None;
    }
    Some((asset_id.to_string(), decode_field(field)))
}

pub fn register_memory_resource(
    asset_id: &str,
    field: &str,
    file_name: String,
    mime: String,
    bytes: Vec<u8>,
) -> String {
    let resource = RuntimeResource {
        file_name,
        mime,
        backing: ResourceBacking::Memory(bytes),
    };
    resources()
        .lock()
        .unwrap()
        .insert(key(asset_id, field), resource);
    resource_url(asset_id, field)
}

pub fn register_packed_resource(
    package_path: &str,
    resource: &PackedResourceRegistration,
) -> String {
    let runtime = RuntimeResource {
        file_name: resource.file_name.clone(),
        mime: resource.mime.clone(),
        backing: ResourceBacking::Packed {
            package_path: package_path.to_string(),
            zip_path: resource.zip_path.clone(),
        },
    };
    resources()
        .lock()
        .unwrap()
        .insert(key(&resource.asset_id, &resource.field), runtime);
    resource_url(&resource.asset_id, &resource.field)
}

pub fn register_file_resource(
    asset_id: &str,
    field: &str,
    file_name: String,
    mime: String,
    path: PathBuf,
) -> String {
    resources().lock().unwrap().insert(
        key(asset_id, field),
        RuntimeResource { file_name, mime, backing: ResourceBacking::File(path) },
    );
    resource_url(asset_id, field)
}

pub fn resource_source_signature(value: &str) -> Option<(u64, u64)> {
    let (asset_id, field) = parse_resource_url(value)?;
    let resource = resources().lock().ok()?.get(&key(&asset_id, &field)).cloned()?;
    let metadata = match resource.backing {
        ResourceBacking::File(path) => std::fs::metadata(path).ok()?,
        ResourceBacking::Packed { package_path, zip_path } => {
            // Use the ZIP entry's own stable fingerprint. Project saves and
            // renames change the package timestamp but not unchanged images.
            let file = File::open(package_path).ok()?;
            let mut archive = ZipArchive::new(file).ok()?;
            let entry = archive.by_name(&zip_path).ok()?;
            return Some((entry.size(), entry.crc32() as u64));
        }
        ResourceBacking::Memory(bytes) => return Some((bytes.len() as u64, 0)),
    };
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((metadata.len(), modified))
}

pub fn read_resource(asset_id: &str, field: &str) -> Result<(Vec<u8>, String, String), String> {
    let resource = resources()
        .lock()
        .unwrap()
        .get(&key(asset_id, field))
        .cloned()
        .ok_or_else(|| "Resource is no longer available in this session".to_string())?;
    let bytes = match resource.backing {
        ResourceBacking::Memory(bytes) => bytes,
        ResourceBacking::File(path) => std::fs::read(path)
            .map_err(|e| format!("Read cached resource failed: {e}"))?,
        ResourceBacking::Packed {
            package_path,
            zip_path,
        } => {
            let file = File::open(&package_path)
                .map_err(|e| format!("Open project package failed: {e}"))?;
            let mut archive =
                ZipArchive::new(file).map_err(|e| format!("Read project package failed: {e}"))?;
            let mut entry = archive
                .by_name(&zip_path)
                .map_err(|e| format!("Read packaged resource failed: {e}"))?;
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| format!("Read packaged resource bytes failed: {e}"))?;
            bytes
        }
    };
    Ok((bytes, resource.mime, resource.file_name))
}

pub fn read_resource_url(value: &str) -> Result<(Vec<u8>, String, String), String> {
    let (asset_id, field) =
        parse_resource_url(value).ok_or_else(|| "Invalid RefMind3D resource URL".to_string())?;
    read_resource(&asset_id, &field)
}

fn response(status: u16, content_type: &str, body: Vec<u8>, cacheable: bool) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", if cacheable { "public, max-age=31536000, immutable" } else { "no-store" })
        .header("Content-Type", content_type)
        .body(body)
        .unwrap()
}

pub fn protocol_response(request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let cacheable = parse_resource_url(&uri).map(|(_, field)| field.starts_with("cachePreview:") || field.starts_with("cacheThumbnail:")).unwrap_or(false);
    match read_resource_url(&uri) {
        Ok((bytes, mime, _)) => response(200, &mime, bytes, cacheable),
        Err(message) => response(404, "text/plain; charset=utf-8", message.into_bytes(), false),
    }
}
