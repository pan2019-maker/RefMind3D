use anyhow::{anyhow, Context};
use base64::Engine as _;
use calamine::{open_workbook_auto, Data, Reader};
use chrono::Utc;
use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::runtime_assets;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMedia {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDocument {
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
    pub extracted_text: String,
    pub content_html: Option<String>,
    pub document_media: Vec<DocumentMedia>,
    pub spreadsheet_data: Option<SpreadsheetWorkbook>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetWorkbook {
    pub kind: String,
    pub active_sheet_index: usize,
    pub sheets: Vec<SpreadsheetSheet>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetSheet {
    pub id: String,
    pub name: String,
    pub rows: Vec<SpreadsheetRow>,
    pub columns: Vec<SpreadsheetColumn>,
    pub merges: Vec<SpreadsheetMerge>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetRow {
    pub index: u32,
    pub height: Option<f64>,
    pub cells: Vec<SpreadsheetCell>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetColumn {
    pub index: u32,
    pub width: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetMerge {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetCellStyle {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub font_size: Option<f64>,
    pub font_family: Option<String>,
    pub color: Option<String>,
    pub background_color: Option<String>,
    pub align: Option<String>,
    pub vertical_align: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetCell {
    pub row: u32,
    pub col: u32,
    pub value: String,
    pub formula: Option<String>,
    pub style: Option<SpreadsheetCellStyle>,
}

const DOCUMENT_FORMATS: &[&str] = &[
    "txt", "md", "rtf", "doc", "docx", "pdf", "csv", "tsv", "xls", "xlsx",
];

#[tauri::command]
pub async fn import_document_asset(
    source_path: String,
    project_root: String,
) -> Result<ImportedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_document_asset_sync(source_path, project_root)
    })
    .await
    .map_err(|e| format!("Document import task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_runtime_document_asset(
    data_url: String,
    name_hint: String,
) -> Result<ImportedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || import_document_data_url_sync(data_url, name_hint))
        .await
        .map_err(|e| format!("Runtime document registration task failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_editable_document_asset(
    format: String,
    content: String,
    output_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_editable_document_asset_sync(&format, &content, &PathBuf::from(output_path))
    })
    .await
    .map_err(|e| format!("Document export task failed: {e}"))?
    .map_err(|e| e.to_string())
}

fn import_document_asset_sync(
    source_path: String,
    _project_root: String,
) -> anyhow::Result<ImportedDocument> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(anyhow!("File does not exist: {}", source_path));
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();

    if !DOCUMENT_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported document/table/PDF format: .{}", ext));
    }

    let id = Uuid::new_v4().to_string();
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("document")
        .to_string();
    let file_size = fs::metadata(&source)
        .with_context(|| format!("Read document metadata failed: {}", source.display()))?
        .len();
    let kind = if ext == "pdf" {
        "pdf"
    } else if ["csv", "tsv", "xls", "xlsx"].contains(&ext.as_str()) {
        "table"
    } else {
        "document"
    };

    let parsed_docx = if ext == "docx" {
        parse_docx_to_html(&source, &id).ok()
    } else {
        None
    };
    let parsed_xlsx = if ext == "xlsx" {
        parse_xlsx_to_workbook(&source).ok()
    } else {
        None
    };
    let extracted_text = parsed_docx
        .as_ref()
        .map(|doc| doc.text.clone())
        .or_else(|| parsed_xlsx.as_ref().map(spreadsheet_to_text))
        .unwrap_or_else(|| extract_editable_text(&source, &name, &ext, &id));
    let content_html = parsed_docx.as_ref().map(|doc| doc.html.clone());
    let document_media = parsed_docx.map(|doc| doc.media).unwrap_or_default();
    let source_text = source.to_string_lossy().to_string();

    Ok(ImportedDocument {
        id,
        kind: kind.to_string(),
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
        extracted_text,
        content_html,
        document_media,
        spreadsheet_data: parsed_xlsx,
    })
}

fn import_document_data_url_sync(
    data_url: String,
    name_hint: String,
) -> anyhow::Result<ImportedDocument> {
    let (bytes, mime) = decode_data_url(&data_url)?;
    let ext = PathBuf::from(&name_hint)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if !DOCUMENT_FORMATS.contains(&ext.as_str()) {
        return Err(anyhow!("Unsupported document/table/PDF format: .{}", ext));
    }
    let id = Uuid::new_v4().to_string();
    let name = sanitize_file_name(if name_hint.trim().is_empty() {
        "document"
    } else {
        &name_hint
    });
    let kind = if ext == "pdf" {
        "pdf"
    } else if ["csv", "tsv", "xls", "xlsx"].contains(&ext.as_str()) {
        "table"
    } else {
        "document"
    };
    let project_asset_path = runtime_assets::register_memory_resource(
        &id,
        "projectAssetPath",
        name.clone(),
        mime.unwrap_or_else(|| mime_for_file_name(&name).to_string()),
        bytes.clone(),
    );
    let parsed_docx = if ext == "docx" {
        parse_docx_to_html_from_bytes(&bytes, &id).ok()
    } else {
        None
    };
    let parsed_xlsx = if ext == "xlsx" {
        parse_xlsx_to_workbook_from_bytes(&bytes).ok()
    } else {
        None
    };
    let extracted_text = parsed_docx
        .as_ref()
        .map(|doc| doc.text.clone())
        .or_else(|| parsed_xlsx.as_ref().map(spreadsheet_to_text))
        .unwrap_or_else(|| extract_text_from_document_bytes(&bytes, &ext));
    let content_html = parsed_docx.as_ref().map(|doc| doc.html.clone());
    let document_media = parsed_docx.map(|doc| doc.media).unwrap_or_default();
    Ok(ImportedDocument {
        id,
        kind: kind.to_string(),
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
        extracted_text,
        content_html,
        document_media,
        spreadsheet_data: parsed_xlsx,
    })
}

struct ParsedDocx {
    html: String,
    text: String,
    media: Vec<DocumentMedia>,
}

fn parse_docx_to_html(path: &Path, id: &str) -> anyhow::Result<ParsedDocx> {
    let file = File::open(path)?;
    parse_docx_archive(file, id)
}

fn parse_docx_to_html_from_bytes(bytes: &[u8], id: &str) -> anyhow::Result<ParsedDocx> {
    parse_docx_archive(Cursor::new(bytes.to_vec()), id)
}

fn parse_docx_archive<R: Read + Seek>(reader: R, id: &str) -> anyhow::Result<ParsedDocx> {
    let mut archive = ZipArchive::new(reader)?;
    let mut document_xml = String::new();
    archive
        .by_name("word/document.xml")?
        .read_to_string(&mut document_xml)?;
    let rels = read_docx_relationships(&mut archive).unwrap_or_default();
    let styles = read_docx_styles(&mut archive).unwrap_or_default();
    let media = extract_docx_media(&mut archive, id)?;
    let media_by_name: HashMap<String, DocumentMedia> = media
        .iter()
        .cloned()
        .map(|item| (format!("media/{}", item.name), item))
        .collect();

    let body = between(&document_xml, "<w:body", "</w:body>").unwrap_or(&document_xml);
    let html = docx_blocks_to_html(body, &rels, &media_by_name, &styles);
    let text = html_to_plain_text(&html);
    Ok(ParsedDocx { html, text, media })
}

#[derive(Clone, Default)]
struct DocxParagraphStyle {
    tag: String,
}

fn read_docx_styles<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> anyhow::Result<HashMap<String, DocxParagraphStyle>> {
    let mut styles_xml = String::new();
    archive
        .by_name("word/styles.xml")?
        .read_to_string(&mut styles_xml)?;
    let mut styles = HashMap::new();
    for style in collect_tags(&styles_xml, "w:style") {
        if attr_value(style, "w:type").as_deref() != Some("paragraph") {
            continue;
        }
        let Some(style_id) = attr_value(style, "w:styleId") else {
            continue;
        };
        let name = collect_tags(style, "w:name")
            .first()
            .and_then(|tag| attr_value(tag, "w:val"))
            .unwrap_or_else(|| style_id.clone())
            .to_ascii_lowercase();
        let tag = if name.contains("heading 1") || style_id.eq_ignore_ascii_case("Heading1") {
            "h1"
        } else if name.contains("heading 2") || style_id.eq_ignore_ascii_case("Heading2") {
            "h2"
        } else if name.contains("heading 3") || style_id.eq_ignore_ascii_case("Heading3") {
            "h3"
        } else {
            "p"
        };
        styles.insert(
            style_id,
            DocxParagraphStyle {
                tag: tag.to_string(),
            },
        );
    }
    Ok(styles)
}

fn read_docx_relationships<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> anyhow::Result<HashMap<String, String>> {
    let mut rels_xml = String::new();
    archive
        .by_name("word/_rels/document.xml.rels")?
        .read_to_string(&mut rels_xml)?;
    let mut rels = HashMap::new();
    for rel in collect_tags(&rels_xml, "Relationship") {
        if let (Some(id), Some(target)) = (attr_value(rel, "Id"), attr_value(rel, "Target")) {
            rels.insert(id, target);
        }
    }
    Ok(rels)
}

fn extract_docx_media<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    id: &str,
) -> anyhow::Result<Vec<DocumentMedia>> {
    let mut media = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name().replace('\\', "/");
        if !name.starts_with("word/media/") || name.ends_with('/') {
            continue;
        }
        let file_name = Path::new(&name)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("image.bin")
            .to_string();
        let clean_name = sanitize_file_name(&file_name);
        let media_id = format!("media{}", media.len() + 1);
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let mime = mime_for_file_name(&clean_name).to_string();
        let resource_path = runtime_assets::register_memory_resource(
            id,
            &format!("documentMedia:{media_id}"),
            clean_name,
            mime.clone(),
            bytes,
        );
        media.push(DocumentMedia {
            id: media_id,
            name: file_name,
            mime,
            path: resource_path,
        });
    }
    Ok(media)
}

fn docx_blocks_to_html(
    xml: &str,
    rels: &HashMap<String, String>,
    media_by_name: &HashMap<String, DocumentMedia>,
    styles: &HashMap<String, DocxParagraphStyle>,
) -> String {
    let mut html = String::from("<article class=\"docx-preview\">");
    let mut cursor = 0usize;
    while let Some((tag, start, end)) = next_block(xml, cursor) {
        let block = &xml[start..end];
        if tag == "w:p" {
            html.push_str(&paragraph_to_html(block, rels, media_by_name, styles));
        } else if tag == "w:tbl" {
            html.push_str(&table_to_html(block, rels, media_by_name, styles));
        }
        cursor = end;
    }
    html.push_str("</article>");
    html
}

fn next_block(xml: &str, from: usize) -> Option<(&'static str, usize, usize)> {
    let p = xml[from..].find("<w:p").map(|i| from + i);
    let t = xml[from..].find("<w:tbl").map(|i| from + i);
    match (p, t) {
        (Some(pi), Some(ti)) if pi < ti => close_block(xml, "w:p", pi),
        (Some(_), Some(ti)) => close_block(xml, "w:tbl", ti),
        (Some(pi), None) => close_block(xml, "w:p", pi),
        (None, Some(ti)) => close_block(xml, "w:tbl", ti),
        _ => None,
    }
}

fn close_block(xml: &str, tag: &'static str, start: usize) -> Option<(&'static str, usize, usize)> {
    let close = format!("</{tag}>");
    let end = xml[start..].find(&close).map(|i| start + i + close.len())?;
    Some((tag, start, end))
}

fn paragraph_to_html(
    xml: &str,
    rels: &HashMap<String, String>,
    media_by_name: &HashMap<String, DocumentMedia>,
    styles: &HashMap<String, DocxParagraphStyle>,
) -> String {
    let mut inner = String::new();
    for run in collect_tags(xml, "w:r") {
        inner.push_str(&run_to_html(run, rels, media_by_name));
    }
    if inner.trim().is_empty() {
        return "<p><br></p>".to_string();
    }
    let style_tag = attr_from_tag(xml, "w:pStyle", "w:val")
        .and_then(|style_id| styles.get(&style_id).map(|style| style.tag.clone()));
    let tag = if let Some(tag) = style_tag {
        tag
    } else if xml.contains("Heading1") || xml.contains("heading 1") {
        "h1".to_string()
    } else if xml.contains("Heading2") || xml.contains("heading 2") {
        "h2".to_string()
    } else if xml.contains("Heading3") || xml.contains("heading 3") {
        "h3".to_string()
    } else if xml.contains("<w:numPr>") {
        "li".to_string()
    } else {
        "p".to_string()
    };
    let align_style = attr_from_tag(xml, "w:jc", "w:val")
        .map(|v| format!(" style=\"text-align:{}\"", html_escape_attr(&v)));
    format!("<{tag}{}>{inner}</{tag}>", align_style.unwrap_or_default())
}

fn table_to_html(
    xml: &str,
    rels: &HashMap<String, String>,
    media_by_name: &HashMap<String, DocumentMedia>,
    styles: &HashMap<String, DocxParagraphStyle>,
) -> String {
    let mut html = String::from("<table><tbody>");
    for row in collect_tags(xml, "w:tr") {
        html.push_str("<tr>");
        for cell in collect_tags(row, "w:tc") {
            let colspan = attr_from_tag(cell, "w:gridSpan", "w:val")
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|value| *value > 1)
                .map(|value| format!(" colspan=\"{value}\""))
                .unwrap_or_default();
            html.push_str(&format!("<td{colspan}>"));
            let mut cursor = 0usize;
            while let Some((_, start, end)) = close_block_from(cell, "w:p", cursor) {
                html.push_str(&paragraph_to_html(
                    &cell[start..end],
                    rels,
                    media_by_name,
                    styles,
                ));
                cursor = end;
            }
            html.push_str("</td>");
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    html
}

fn close_block_from(
    xml: &str,
    tag: &'static str,
    from: usize,
) -> Option<(&'static str, usize, usize)> {
    let open = format!("<{tag}");
    let start = xml[from..].find(&open).map(|i| from + i)?;
    close_block(xml, tag, start)
}

fn run_to_html(
    xml: &str,
    rels: &HashMap<String, String>,
    media_by_name: &HashMap<String, DocumentMedia>,
) -> String {
    let mut out = String::new();
    if let Some(embed_id) = attr_value(xml, "r:embed") {
        if let Some(target) = rels
            .get(&embed_id)
            .and_then(|target| media_by_name.get(target))
        {
            out.push_str(&format!(
                "<img src=\"{}\" data-refmind-src=\"{}\" alt=\"{}\">",
                html_escape_attr(&target.path),
                html_escape_attr(&target.path),
                html_escape_attr(&target.name)
            ));
        }
    }
    for text_tag in collect_tags(xml, "w:t") {
        out.push_str(&html_escape_text(inner_text(text_tag)));
    }
    if xml.contains("<w:tab") {
        out.push_str("&emsp;");
    }
    if xml.contains("<w:br") {
        out.push_str("<br>");
    }
    if out.is_empty() {
        return out;
    }

    let mut style = Vec::new();
    if let Some(color) = attr_from_tag(xml, "w:color", "w:val").filter(|v| v != "auto") {
        style.push(format!("color:#{}", html_escape_attr(&color)));
    }
    if let Some(size) = attr_from_tag(xml, "w:sz", "w:val").and_then(|v| v.parse::<f32>().ok()) {
        style.push(format!("font-size:{:.1}pt", size / 2.0));
    }
    if let Some(font) = attr_from_tag(xml, "w:rFonts", "w:ascii")
        .or_else(|| attr_from_tag(xml, "w:rFonts", "w:eastAsia"))
    {
        style.push(format!("font-family:'{}'", html_escape_attr(&font)));
    }
    let style_attr = if style.is_empty() {
        String::new()
    } else {
        format!(" style=\"{}\"", style.join(";"))
    };
    let mut wrapped = format!("<span{style_attr}>{out}</span>");
    if xml.contains("<w:u") {
        wrapped = format!("<u>{wrapped}</u>");
    }
    if xml.contains("<w:i") {
        wrapped = format!("<em>{wrapped}</em>");
    }
    if xml.contains("<w:b") {
        wrapped = format!("<strong>{wrapped}</strong>");
    }
    wrapped
}

fn collect_tags<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(start_rel) = find_open_tag(xml, tag, cursor) {
        let start = start_rel;
        if let Some(end_rel) = xml[start..].find(&close) {
            let end = start + end_rel + close.len();
            out.push(&xml[start..end]);
            cursor = end;
        } else if let Some(end_rel) = xml[start..].find("/>") {
            let end = start + end_rel + 2;
            out.push(&xml[start..end]);
            cursor = end;
        } else {
            break;
        }
    }
    out
}

fn find_open_tag(xml: &str, tag: &str, from: usize) -> Option<usize> {
    let open = format!("<{tag}");
    let mut cursor = from;
    while let Some(rel) = xml[cursor..].find(&open) {
        let start = cursor + rel;
        let next = xml[start + open.len()..].chars().next();
        if matches!(next, Some(' ' | '\t' | '\r' | '\n' | '/' | '>')) {
            return Some(start);
        }
        cursor = start + open.len();
    }
    None
}

fn attr_value(xml: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    let start = xml.find(&pattern)? + pattern.len();
    let end = xml[start..].find('"')? + start;
    Some(xml[start..end].to_string())
}

fn attr_from_tag(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let start = find_open_tag(xml, tag, 0)?;
    let end = xml[start..].find('>').map(|idx| start + idx)?;
    attr_value(&xml[start..=end], attr)
}

fn between<'a>(text: &'a str, start_pat: &str, end_pat: &str) -> Option<&'a str> {
    let start = text.find(start_pat)?;
    let start = text[start..].find('>').map(|i| start + i + 1)?;
    let end = text[start..].find(end_pat).map(|i| start + i)?;
    Some(&text[start..end])
}

fn inner_text(tag: &str) -> &str {
    if let Some(start) = tag.find('>') {
        if let Some(end) = tag.rfind('<') {
            if end > start {
                return &tag[start + 1..end];
            }
        }
    }
    ""
}

fn extract_editable_text(path: &PathBuf, name: &str, ext: &str, id: &str) -> String {
    match ext {
        "txt" | "md" | "csv" | "tsv" => {
            read_text_lossless(path).unwrap_or_else(|_| fallback_text(name, ext))
        }
        "rtf" => read_text_lossless(path)
            .map(strip_rtf_control_words)
            .unwrap_or_else(|_| fallback_text(name, ext)),
        "doc" => {
            format!("{name}\n\nLegacy .doc preview is limited. The original file is preserved.")
        }
        "docx" => fallback_text(name, ext),
        "xls" | "xlsx" => extract_spreadsheet_text(path, id).unwrap_or_else(|error| {
            format!("{name}\n\nExcel content read failed: {error}\nThe original file is preserved.")
        }),
        "pdf" => format!("{name}\n\nPDF is preserved. Edit the canvas note layer for annotations."),
        _ => fallback_text(name, ext),
    }
}

fn extract_text_from_document_bytes(bytes: &[u8], ext: &str) -> String {
    match ext {
        "txt" | "md" | "csv" | "tsv" => decode_text_lossless(bytes),
        "rtf" => strip_rtf_control_words(decode_text_lossless(bytes)),
        "doc" => "Legacy .doc preview is limited. The original file is preserved.".to_string(),
        "xls" | "xlsx" => "Spreadsheet preview is limited for pathless drag/drop. The original file is preserved in the project package.".to_string(),
        "pdf" => "PDF is preserved. Edit the canvas note layer for annotations.".to_string(),
        _ => "The original file is preserved in the project package.".to_string(),
    }
}

fn decode_text_lossless(bytes: &[u8]) -> String {
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return text;
    }
    let (cow, _, had_errors) = GBK.decode(bytes);
    if !had_errors || !cow.is_empty() {
        return cow.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
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

fn read_text_lossless(path: &Path) -> anyhow::Result<String> {
    let bytes = fs::read(path)?;
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        return Ok(text);
    }
    let (cow, _, had_errors) = GBK.decode(&bytes);
    if !had_errors || !cow.is_empty() {
        return Ok(cow.into_owned());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn extract_spreadsheet_text(path: &PathBuf, _id: &str) -> anyhow::Result<String> {
    let mut workbook = open_workbook_auto(path)
        .with_context(|| format!("Open Excel file failed: {}", path.display()))?;
    let sheet_names = workbook.sheet_names().to_owned();
    if sheet_names.is_empty() {
        return Err(anyhow!("No worksheet found"));
    }

    let mut output = String::new();
    let mut wrote_any = false;
    for sheet_name in sheet_names.iter().take(12) {
        let range = match workbook.worksheet_range(sheet_name) {
            Ok(range) => range,
            Err(error) => {
                output.push_str(&format!("Sheet {sheet_name} read failed: {error}\n\n"));
                continue;
            }
        };

        output.push_str(&format!("Sheet: {sheet_name}\n"));
        let mut row_count = 0usize;
        for row in range.rows() {
            if row_count >= 600 {
                output
                    .push_str("... truncated at 600 rows. The original Excel file is preserved.\n");
                break;
            }
            let cells: Vec<String> = row.iter().map(cell_to_string).collect();
            if cells.iter().all(|cell| cell.trim().is_empty()) {
                continue;
            }
            output.push_str(&cells.join("\t"));
            output.push('\n');
            row_count += 1;
            wrote_any = true;
        }
        output.push('\n');
    }

    if !wrote_any {
        return Err(anyhow!("Workbook is empty or has no readable cells"));
    }
    Ok(output.trim().to_string())
}

fn parse_xlsx_to_workbook(path: &Path) -> anyhow::Result<SpreadsheetWorkbook> {
    let file = File::open(path)?;
    parse_xlsx_archive(file)
}

fn parse_xlsx_to_workbook_from_bytes(bytes: &[u8]) -> anyhow::Result<SpreadsheetWorkbook> {
    parse_xlsx_archive(Cursor::new(bytes.to_vec()))
}

fn parse_xlsx_archive<R: Read + Seek>(reader: R) -> anyhow::Result<SpreadsheetWorkbook> {
    let mut archive = ZipArchive::new(reader)?;
    let workbook_xml = zip_text(&mut archive, "xl/workbook.xml")?;
    let workbook_rels = zip_text(&mut archive, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let shared_strings =
        parse_shared_strings(&zip_text(&mut archive, "xl/sharedStrings.xml").unwrap_or_default());
    let styles = parse_xlsx_styles(&zip_text(&mut archive, "xl/styles.xml").unwrap_or_default());
    let rel_targets = parse_relationship_targets(&workbook_rels);
    let sheets = parse_workbook_sheets(&workbook_xml, &rel_targets);
    if sheets.is_empty() {
        return Err(anyhow!("No worksheet found"));
    }

    let mut parsed_sheets = Vec::new();
    for (idx, sheet) in sheets.into_iter().take(24).enumerate() {
        let xml = match zip_text(&mut archive, &sheet.path) {
            Ok(xml) => xml,
            Err(_) => continue,
        };
        parsed_sheets.push(parse_worksheet_xml(
            &xml,
            &sheet.name,
            idx + 1,
            &shared_strings,
            &styles,
        ));
    }
    if parsed_sheets.is_empty() {
        return Err(anyhow!("No readable worksheet found"));
    }
    Ok(SpreadsheetWorkbook {
        kind: "spreadsheet-workbook".to_string(),
        active_sheet_index: 0,
        sheets: parsed_sheets,
    })
}

fn zip_text<R: Read + Seek>(archive: &mut ZipArchive<R>, path: &str) -> anyhow::Result<String> {
    let mut text = String::new();
    archive.by_name(path)?.read_to_string(&mut text)?;
    Ok(text)
}

#[derive(Clone)]
struct WorkbookSheetRef {
    name: String,
    path: String,
}

fn parse_relationship_targets(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for rel in collect_tags(xml, "Relationship") {
        if let (Some(id), Some(target)) = (attr_value(rel, "Id"), attr_value(rel, "Target")) {
            out.insert(id, normalize_xlsx_part_path("xl", &target));
        }
    }
    out
}

fn normalize_xlsx_part_path(base_dir: &str, target: &str) -> String {
    let clean = target.trim_start_matches('/');
    if clean.starts_with("xl/") {
        clean.to_string()
    } else {
        format!("{}/{}", base_dir.trim_end_matches('/'), clean)
    }
}

fn parse_workbook_sheets(
    xml: &str,
    rel_targets: &HashMap<String, String>,
) -> Vec<WorkbookSheetRef> {
    let mut sheets = Vec::new();
    for sheet in collect_tags(xml, "sheet") {
        let name =
            attr_value(sheet, "name").unwrap_or_else(|| format!("Sheet{}", sheets.len() + 1));
        let rel_id = attr_value(sheet, "r:id").unwrap_or_default();
        let path = rel_targets
            .get(&rel_id)
            .cloned()
            .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", sheets.len() + 1));
        sheets.push(WorkbookSheetRef { name, path });
    }
    sheets
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let mut strings = Vec::new();
    for item in collect_tags(xml, "si") {
        let mut text = String::new();
        for t in collect_tags(item, "t") {
            text.push_str(&html_unescape(inner_text(t)));
        }
        strings.push(text);
    }
    strings
}

#[derive(Clone, Default)]
struct ParsedXlsxStyles {
    cell_styles: Vec<Option<SpreadsheetCellStyle>>,
}

fn parse_xlsx_styles(xml: &str) -> ParsedXlsxStyles {
    let fonts = parse_xlsx_fonts(between(xml, "<fonts", "</fonts>").unwrap_or(""));
    let fills = parse_xlsx_fills(between(xml, "<fills", "</fills>").unwrap_or(""));
    let mut cell_styles = Vec::new();
    let cell_xfs = between(xml, "<cellXfs", "</cellXfs>").unwrap_or("");
    for xf in collect_tags(cell_xfs, "xf") {
        let font_id = attr_value(xf, "fontId")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        let fill_id = attr_value(xf, "fillId")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        let mut style = fonts.get(font_id).cloned().unwrap_or_default();
        if let Some(fill) = fills.get(fill_id).and_then(Clone::clone) {
            style.background_color = Some(fill);
        }
        if let Some(alignment) = collect_tags(xf, "alignment").first() {
            if let Some(horizontal) = attr_value(alignment, "horizontal") {
                style.align = Some(
                    match horizontal.as_str() {
                        "center" => "center",
                        "right" => "right",
                        _ => "left",
                    }
                    .to_string(),
                );
            }
            if let Some(vertical) = attr_value(alignment, "vertical") {
                style.vertical_align = Some(
                    match vertical.as_str() {
                        "center" => "middle",
                        "bottom" => "bottom",
                        _ => "top",
                    }
                    .to_string(),
                );
            }
        }
        cell_styles.push(if style_is_empty(&style) {
            None
        } else {
            Some(style)
        });
    }
    ParsedXlsxStyles { cell_styles }
}

fn parse_xlsx_fonts(xml: &str) -> Vec<SpreadsheetCellStyle> {
    let mut fonts = Vec::new();
    for font in collect_tags(xml, "font") {
        let mut style = SpreadsheetCellStyle::default();
        if font.contains("<b") {
            style.bold = Some(true);
        }
        if font.contains("<i") {
            style.italic = Some(true);
        }
        if font.contains("<u") {
            style.underline = Some(true);
        }
        if let Some(sz) = collect_tags(font, "sz")
            .first()
            .and_then(|tag| attr_value(tag, "val"))
            .and_then(|v| v.parse::<f64>().ok())
        {
            style.font_size = Some(sz);
        }
        if let Some(name) = collect_tags(font, "name")
            .first()
            .and_then(|tag| attr_value(tag, "val"))
        {
            style.font_family = Some(name);
        }
        if let Some(color) = collect_tags(font, "color")
            .first()
            .and_then(|tag| attr_value(tag, "rgb"))
            .and_then(|v| normalize_office_color(&v))
        {
            style.color = Some(color);
        }
        fonts.push(style);
    }
    fonts
}

fn parse_xlsx_fills(xml: &str) -> Vec<Option<String>> {
    let mut fills = Vec::new();
    for fill in collect_tags(xml, "fill") {
        let color = collect_tags(fill, "fgColor")
            .first()
            .and_then(|tag| attr_value(tag, "rgb"))
            .and_then(|v| normalize_office_color(&v));
        fills.push(color);
    }
    fills
}

fn style_is_empty(style: &SpreadsheetCellStyle) -> bool {
    style.bold.is_none()
        && style.italic.is_none()
        && style.underline.is_none()
        && style.font_size.is_none()
        && style.font_family.is_none()
        && style.color.is_none()
        && style.background_color.is_none()
        && style.align.is_none()
        && style.vertical_align.is_none()
}

fn normalize_office_color(value: &str) -> Option<String> {
    let clean = value.trim().trim_start_matches('#');
    if clean.len() == 8 {
        Some(format!("#{}", &clean[2..]))
    } else if clean.len() == 6 {
        Some(format!("#{clean}"))
    } else {
        None
    }
}

fn parse_worksheet_xml(
    xml: &str,
    name: &str,
    sheet_index: usize,
    shared_strings: &[String],
    styles: &ParsedXlsxStyles,
) -> SpreadsheetSheet {
    let mut rows = Vec::new();
    for row_tag in collect_tags(xml, "row").into_iter().take(5000) {
        let row_index = attr_value(row_tag, "r")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or_else(|| rows.len() as u32 + 1);
        let height = attr_value(row_tag, "ht").and_then(|v| v.parse::<f64>().ok());
        let mut cells = Vec::new();
        for cell_tag in collect_tags(row_tag, "c") {
            let reference = attr_value(cell_tag, "r").unwrap_or_else(|| format!("A{row_index}"));
            let (cell_col, cell_row) =
                parse_cell_ref(&reference).unwrap_or((cells.len() as u32 + 1, row_index));
            let value = xlsx_cell_value(cell_tag, shared_strings);
            let formula = collect_tags(cell_tag, "f")
                .first()
                .map(|tag| html_unescape(inner_text(tag)));
            let style = attr_value(cell_tag, "s")
                .and_then(|v| v.parse::<usize>().ok())
                .and_then(|idx| styles.cell_styles.get(idx).cloned())
                .flatten();
            if value.trim().is_empty() && formula.is_none() && style.is_none() {
                continue;
            }
            cells.push(SpreadsheetCell {
                row: cell_row,
                col: cell_col,
                value,
                formula,
                style,
            });
        }
        if !cells.is_empty() {
            rows.push(SpreadsheetRow {
                index: row_index,
                height,
                cells,
            });
        }
    }
    SpreadsheetSheet {
        id: format!("sheet{sheet_index}"),
        name: name.to_string(),
        rows,
        columns: parse_worksheet_columns(xml),
        merges: parse_worksheet_merges(xml),
    }
}

fn parse_worksheet_columns(xml: &str) -> Vec<SpreadsheetColumn> {
    let mut out = Vec::new();
    for col in collect_tags(xml, "col") {
        let min = attr_value(col, "min")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(1);
        let max = attr_value(col, "max")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(min);
        let width = attr_value(col, "width").and_then(|v| v.parse::<f64>().ok());
        for index in min..=max.min(min + 200) {
            out.push(SpreadsheetColumn { index, width });
        }
    }
    out
}

fn parse_worksheet_merges(xml: &str) -> Vec<SpreadsheetMerge> {
    let mut out = Vec::new();
    for merge in collect_tags(xml, "mergeCell") {
        let Some(reference) = attr_value(merge, "ref") else {
            continue;
        };
        let Some((start, end)) = reference.split_once(':') else {
            continue;
        };
        if let (Some((start_col, start_row)), Some((end_col, end_row))) =
            (parse_cell_ref(start), parse_cell_ref(end))
        {
            out.push(SpreadsheetMerge {
                start_row,
                start_col,
                end_row,
                end_col,
            });
        }
    }
    out
}

fn xlsx_cell_value(cell_xml: &str, shared_strings: &[String]) -> String {
    if attr_value(cell_xml, "t").as_deref() == Some("inlineStr") {
        return collect_tags(cell_xml, "t")
            .iter()
            .map(|tag| html_unescape(inner_text(tag)))
            .collect::<Vec<_>>()
            .join("");
    }
    let raw = collect_tags(cell_xml, "v")
        .first()
        .map(|tag| html_unescape(inner_text(tag)))
        .unwrap_or_default();
    match attr_value(cell_xml, "t").as_deref() {
        Some("s") => raw
            .parse::<usize>()
            .ok()
            .and_then(|idx| shared_strings.get(idx).cloned())
            .unwrap_or(raw),
        Some("b") => {
            if raw == "1" {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        _ => raw,
    }
}

fn parse_cell_ref(reference: &str) -> Option<(u32, u32)> {
    let mut col = 0u32;
    let mut row = String::new();
    for ch in reference.chars() {
        if ch.is_ascii_alphabetic() {
            col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        } else if ch.is_ascii_digit() {
            row.push(ch);
        }
    }
    let row = row.parse::<u32>().ok()?;
    if col == 0 || row == 0 {
        None
    } else {
        Some((col, row))
    }
}

fn spreadsheet_to_text(workbook: &SpreadsheetWorkbook) -> String {
    let mut out = String::new();
    for sheet in workbook.sheets.iter().take(12) {
        out.push_str(&format!("Sheet: {}\n", sheet.name));
        for row in sheet.rows.iter().take(600) {
            let max_col = row.cells.iter().map(|cell| cell.col).max().unwrap_or(0);
            let mut cells = vec![String::new(); max_col as usize];
            for cell in &row.cells {
                if cell.col > 0 {
                    cells[(cell.col - 1) as usize] = cell.value.clone();
                }
            }
            if cells.iter().any(|cell| !cell.trim().is_empty()) {
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
        }
        out.push('\n');
    }
    out.trim().to_string()
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.trim().to_string(),
        Data::Float(value) => {
            if value.fract().abs() < f64::EPSILON {
                format!("{:.0}", value)
            } else {
                let mut text = format!("{}", value);
                if text.contains('.') {
                    while text.ends_with('0') {
                        text.pop();
                    }
                    if text.ends_with('.') {
                        text.pop();
                    }
                }
                text
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Data::Error(value) => format!("{:?}", value),
        other => other.to_string(),
    }
}

fn fallback_text(name: &str, ext: &str) -> String {
    format!("{name}\n\nRecognized as .{ext}. Double-click to edit this canvas content.")
}

fn strip_rtf_control_words(input: String) -> String {
    let mut out = String::new();
    let mut skip = false;
    for c in input.chars() {
        match c {
            '{' | '}' => {}
            '\\' => skip = true,
            ' ' | '\n' | '\r' | '\t' if skip => skip = false,
            _ if skip => {}
            _ => out.push(c),
        }
    }
    out
}

fn export_editable_document_asset_sync(
    format: &str,
    content: &str,
    output_path: &Path,
) -> anyhow::Result<()> {
    let format = format.to_lowercase();
    match format.as_str() {
        "docx" => export_docx_from_html(content, output_path),
        "xlsx" => export_xlsx(content, output_path),
        "xls" => export_excel_html(content, output_path),
        "csv" => {
            fs::write(output_path, normalize_text_for_export(content, ',')).map_err(Into::into)
        }
        "tsv" => {
            fs::write(output_path, normalize_text_for_export(content, '\t')).map_err(Into::into)
        }
        "txt" | "md" | "rtf" | "doc" | "pdf" => {
            fs::write(output_path, html_to_plain_text(content)).map_err(Into::into)
        }
        _ => fs::write(output_path, html_to_plain_text(content)).map_err(Into::into),
    }
}

fn export_docx_from_html(content: &str, output_path: &Path) -> anyhow::Result<()> {
    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let media = collect_docx_export_media(content);
    let document_xml = html_to_document_xml(content, &media);

    zip.start_file("[Content_Types].xml", options)?;
    zip.write_all(content_types_docx_xml(&media).as_bytes())?;
    zip.start_file("_rels/.rels", options)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#)?;
    zip.start_file("word/_rels/document.xml.rels", options)?;
    zip.write_all(docx_rels_xml(&media).as_bytes())?;
    zip.start_file("word/styles.xml", options)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>"#)?;
    for item in &media {
        zip.start_file(format!("word/media/{}", item.name), options)?;
        zip.write_all(&item.bytes)?;
    }
    zip.start_file("word/document.xml", options)?;
    zip.write_all(document_xml.as_bytes())?;
    zip.finish()?;
    Ok(())
}

#[derive(Clone)]
struct DocxExportMedia {
    src: String,
    rel_id: String,
    name: String,
    bytes: Vec<u8>,
}

fn content_types_docx_xml(media: &[DocxExportMedia]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>"#,
    );
    for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp"] {
        let mime = match ext {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        };
        if media
            .iter()
            .any(|item| item.name.to_ascii_lowercase().ends_with(&format!(".{ext}")))
        {
            xml.push_str(&format!(
                r#"<Default Extension="{ext}" ContentType="{mime}"/>"#
            ));
        }
    }
    xml.push_str(r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#);
    xml
}

fn docx_rels_xml(media: &[DocxExportMedia]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for item in media {
        xml.push_str(&format!(
            r#"<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{}"/>"#,
            xml_escape_attr(&item.rel_id),
            xml_escape_attr(&item.name)
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

fn collect_docx_export_media(html: &str) -> Vec<DocxExportMedia> {
    let mut media = Vec::new();
    let mut cursor = 0usize;
    while let Some(start) = html[cursor..].find("<img").map(|idx| cursor + idx) {
        let Some(end) = html[start..].find('>').map(|idx| start + idx) else {
            break;
        };
        let tag = &html[start..=end];
        let src = attr_value(tag, "data-refmind-src")
            .or_else(|| attr_value(tag, "src"))
            .unwrap_or_default();
        if !src.is_empty() && !media.iter().any(|item: &DocxExportMedia| item.src == src) {
            if let Some((bytes, _mime, name)) = read_docx_export_image(&src, media.len() + 1) {
                media.push(DocxExportMedia {
                    src,
                    rel_id: format!("rIdImg{}", media.len() + 1),
                    name,
                    bytes,
                });
            }
        }
        cursor = end + 1;
    }
    media
}

fn read_docx_export_image(src: &str, index: usize) -> Option<(Vec<u8>, String, String)> {
    if runtime_assets::is_resource_url(src) {
        let (bytes, mime, name) = runtime_assets::read_resource_url(src).ok()?;
        return Some((bytes, mime, sanitize_file_name(&name)));
    }
    if src.starts_with("data:image/") {
        let comma = src.find(',')?;
        let header = &src[..comma];
        let ext = header
            .trim_start_matches("data:image/")
            .split(';')
            .next()
            .unwrap_or("png");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&src[comma + 1..])
            .ok()?;
        return Some((bytes, format!("image/{ext}"), format!("image{index}.{ext}")));
    }
    let path = PathBuf::from(src);
    if path.exists() {
        let bytes = fs::read(&path).ok()?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("image.png")
            .to_string();
        return Some((
            bytes,
            mime_for_file_name(&name).to_string(),
            sanitize_file_name(&name),
        ));
    }
    None
}

fn html_to_document_xml(html: &str, media: &[DocxExportMedia]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>"#,
    );
    let mut cursor = 0usize;
    let mut wrote = false;
    while let Some((tag, start, end)) = next_html_block(html, cursor) {
        let block = &html[start..end];
        if tag == "table" {
            xml.push_str(&html_table_to_word_xml(block, media));
        } else {
            xml.push_str(&html_paragraph_to_word_xml(tag, block, media));
        }
        cursor = end;
        wrote = true;
    }
    if !wrote {
        for line in html_to_plain_text(html).lines() {
            xml.push_str(&word_paragraph_xml(
                None,
                &html_inline_to_word_runs(line, media),
            ));
        }
    }
    xml.push_str(r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>"#);
    xml
}

fn next_html_block(html: &str, from: usize) -> Option<(&'static str, usize, usize)> {
    let tags = ["table", "h1", "h2", "h3", "p", "li", "tr"];
    let mut best: Option<(&'static str, usize)> = None;
    for tag in tags {
        if let Some(start) = find_open_tag(html, tag, from) {
            if best.map(|(_, index)| start < index).unwrap_or(true) {
                best = Some((tag, start));
            }
        }
    }
    let (tag, start) = best?;
    let close = format!("</{tag}>");
    let end = html[start..]
        .find(&close)
        .map(|idx| start + idx + close.len())?;
    Some((tag, start, end))
}

#[derive(Default, Clone)]
struct WordRunStyle {
    bold: bool,
    italic: bool,
    underline: bool,
    color: Option<String>,
    font_size_half_points: Option<u32>,
    font_family: Option<String>,
}

fn html_paragraph_to_word_xml(tag: &str, block: &str, media: &[DocxExportMedia]) -> String {
    let style = match tag {
        "h1" => Some("Heading1"),
        "h2" => Some("Heading2"),
        "h3" => Some("Heading3"),
        _ => None,
    };
    let inner = inner_html(block);
    word_paragraph_xml(style, &html_inline_to_word_runs(inner, media))
}

fn word_paragraph_xml(style: Option<&str>, runs: &str) -> String {
    let mut xml = String::from("<w:p>");
    if let Some(style) = style {
        xml.push_str(&format!(r#"<w:pPr><w:pStyle w:val="{style}"/></w:pPr>"#));
    }
    xml.push_str(runs);
    xml.push_str("</w:p>");
    xml
}

fn html_table_to_word_xml(table: &str, media: &[DocxExportMedia]) -> String {
    let mut xml = String::from("<w:tbl><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr>");
    for row in collect_tags(table, "tr") {
        xml.push_str("<w:tr>");
        let mut cells = collect_tags(row, "td");
        cells.extend(collect_tags(row, "th"));
        for cell in cells {
            let colspan = attr_value(cell, "colspan")
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(1);
            xml.push_str("<w:tc><w:tcPr>");
            if colspan > 1 {
                xml.push_str(&format!(r#"<w:gridSpan w:val="{colspan}"/>"#));
            }
            xml.push_str("</w:tcPr>");
            let inner = inner_html(cell);
            xml.push_str(&word_paragraph_xml(
                None,
                &html_inline_to_word_runs(inner, media),
            ));
            xml.push_str("</w:tc>");
        }
        xml.push_str("</w:tr>");
    }
    xml.push_str("</w:tbl>");
    xml
}

fn html_inline_to_word_runs(html: &str, media: &[DocxExportMedia]) -> String {
    let mut xml = String::new();
    let mut cursor = 0usize;
    let mut style = WordRunStyle::default();
    while let Some(tag_start_rel) = html[cursor..].find('<') {
        let tag_start = cursor + tag_start_rel;
        if tag_start > cursor {
            xml.push_str(&word_text_run(
                &html_unescape(&html[cursor..tag_start]),
                &style,
            ));
        }
        let Some(tag_end) = html[tag_start..].find('>').map(|idx| tag_start + idx) else {
            break;
        };
        let tag = &html[tag_start..=tag_end];
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<br") {
            xml.push_str("<w:r><w:br/></w:r>");
        } else if lower.starts_with("<img") {
            let src = attr_value(tag, "data-refmind-src")
                .or_else(|| attr_value(tag, "src"))
                .unwrap_or_default();
            if let Some(item) = media.iter().find(|item| item.src == src) {
                xml.push_str(&word_image_run(&item.rel_id));
            }
        } else if lower.starts_with("</strong") || lower.starts_with("</b") {
            style.bold = false;
        } else if lower.starts_with("<strong") || lower.starts_with("<b") {
            style.bold = true;
        } else if lower.starts_with("</em") || lower.starts_with("</i") {
            style.italic = false;
        } else if lower.starts_with("<em") || lower.starts_with("<i") {
            style.italic = true;
        } else if lower.starts_with("</u") {
            style.underline = false;
        } else if lower.starts_with("<u") {
            style.underline = true;
        } else if lower.starts_with("</span") {
            style.color = None;
            style.font_size_half_points = None;
            style.font_family = None;
        } else if lower.starts_with("<span") {
            apply_inline_css_to_word_style(tag, &mut style);
        }
        cursor = tag_end + 1;
    }
    if cursor < html.len() {
        xml.push_str(&word_text_run(&html_unescape(&html[cursor..]), &style));
    }
    if xml.trim().is_empty() {
        "<w:r><w:t></w:t></w:r>".to_string()
    } else {
        xml
    }
}

fn apply_inline_css_to_word_style(tag: &str, style: &mut WordRunStyle) {
    let Some(css) = attr_value(tag, "style") else {
        return;
    };
    for part in css.split(';') {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('\'').trim_matches('"');
        if key == "color" && value.starts_with('#') {
            style.color = Some(value.trim_start_matches('#').to_string());
        } else if key == "font-size" {
            let number = value
                .trim_end_matches("pt")
                .trim_end_matches("px")
                .parse::<f32>()
                .ok();
            if let Some(number) = number {
                style.font_size_half_points = Some((number * 2.0).round() as u32);
            }
        } else if key == "font-family" {
            style.font_family = Some(value.split(',').next().unwrap_or(value).trim().to_string());
        }
    }
}

fn word_text_run(text: &str, style: &WordRunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut xml = String::from("<w:r>");
    let has_style = style.bold
        || style.italic
        || style.underline
        || style.color.is_some()
        || style.font_size_half_points.is_some()
        || style.font_family.is_some();
    if has_style {
        xml.push_str("<w:rPr>");
        if style.bold {
            xml.push_str("<w:b/>");
        }
        if style.italic {
            xml.push_str("<w:i/>");
        }
        if style.underline {
            xml.push_str(r#"<w:u w:val="single"/>"#);
        }
        if let Some(color) = &style.color {
            xml.push_str(&format!(r#"<w:color w:val="{}"/>"#, xml_escape_attr(color)));
        }
        if let Some(size) = style.font_size_half_points {
            xml.push_str(&format!(r#"<w:sz w:val="{size}"/>"#));
        }
        if let Some(font) = &style.font_family {
            xml.push_str(&format!(
                r#"<w:rFonts w:ascii="{}" w:eastAsia="{}"/>"#,
                xml_escape_attr(font),
                xml_escape_attr(font)
            ));
        }
        xml.push_str("</w:rPr>");
    }
    xml.push_str("<w:t xml:space=\"preserve\">");
    xml.push_str(&xml_escape_text(text));
    xml.push_str("</w:t></w:r>");
    xml
}

fn word_image_run(rel_id: &str) -> String {
    format!(
        r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3600000" cy="2400000"/><wp:docPr id="1" name="RefMind3D Image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="2400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
        xml_escape_attr(rel_id)
    )
}

fn inner_html(tag: &str) -> &str {
    if let Some(start) = tag.find('>') {
        if let Some(end) = tag.rfind("</") {
            if end > start {
                return &tag[start + 1..end];
            }
        }
    }
    ""
}

fn html_to_plain_text(input: &str) -> String {
    let mut text = input
        .replace("</p>", "\n")
        .replace("</h1>", "\n")
        .replace("</h2>", "\n")
        .replace("</h3>", "\n")
        .replace("</li>", "\n")
        .replace("</tr>", "\n")
        .replace("</td>", "\t")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");
    let mut out = String::new();
    let mut in_tag = false;
    for c in text.drain(..) {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    html_unescape(&out)
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn normalize_text_for_export(content: &str, separator: char) -> String {
    let plain = html_to_plain_text(content);
    let mut lines = Vec::new();
    for line in plain.lines() {
        if separator == ',' {
            let cells: Vec<String> = line.split('\t').map(csv_escape).collect();
            lines.push(cells.join(","));
        } else {
            lines.push(line.to_string());
        }
    }
    lines.join("\n")
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[derive(Clone)]
struct ExportSheet {
    name: String,
    rows: Vec<Vec<String>>,
}

fn parse_sheets(content: &str) -> Vec<ExportSheet> {
    let plain = html_to_plain_text(content);
    let mut rows = Vec::new();
    for line in plain.lines() {
        if !line.trim().is_empty() {
            rows.push(line.split('\t').map(|cell| cell.to_string()).collect());
        }
    }
    vec![ExportSheet {
        name: "Sheet1".to_string(),
        rows,
    }]
}

fn export_xlsx(content: &str, output_path: &Path) -> anyhow::Result<()> {
    if let Ok(workbook) = serde_json::from_str::<SpreadsheetWorkbook>(content) {
        if workbook.kind == "spreadsheet-workbook" && !workbook.sheets.is_empty() {
            return export_xlsx_workbook(&workbook, output_path);
        }
    }
    let sheets = parse_sheets(content);
    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", options)?;
    zip.write_all(content_types_xml(sheets.len()).as_bytes())?;
    zip.start_file("_rels/.rels", options)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#)?;
    zip.start_file("xl/workbook.xml", options)?;
    zip.write_all(workbook_xml(&sheets).as_bytes())?;
    zip.start_file("xl/_rels/workbook.xml.rels", options)?;
    zip.write_all(workbook_rels_xml(sheets.len()).as_bytes())?;
    zip.start_file("xl/styles.xml", options)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>"#)?;
    for (idx, sheet) in sheets.iter().enumerate() {
        zip.start_file(format!("xl/worksheets/sheet{}.xml", idx + 1), options)?;
        zip.write_all(worksheet_xml(sheet).as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

fn export_xlsx_workbook(workbook: &SpreadsheetWorkbook, output_path: &Path) -> anyhow::Result<()> {
    let sheets = if workbook.sheets.is_empty() {
        vec![SpreadsheetSheet {
            id: "sheet1".to_string(),
            name: "Sheet1".to_string(),
            ..Default::default()
        }]
    } else {
        workbook.sheets.clone()
    };
    let styles = collect_workbook_styles(&sheets);
    let file = File::create(output_path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", options)?;
    zip.write_all(content_types_xml(sheets.len()).as_bytes())?;
    zip.start_file("_rels/.rels", options)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#)?;
    zip.start_file("xl/workbook.xml", options)?;
    let export_sheets: Vec<ExportSheet> = sheets
        .iter()
        .map(|sheet| ExportSheet {
            name: sheet.name.clone(),
            rows: Vec::new(),
        })
        .collect();
    zip.write_all(workbook_xml(&export_sheets).as_bytes())?;
    zip.start_file("xl/_rels/workbook.xml.rels", options)?;
    zip.write_all(workbook_rels_xml(sheets.len()).as_bytes())?;
    zip.start_file("xl/styles.xml", options)?;
    zip.write_all(xlsx_styles_xml(&styles).as_bytes())?;
    for (idx, sheet) in sheets.iter().enumerate() {
        zip.start_file(format!("xl/worksheets/sheet{}.xml", idx + 1), options)?;
        zip.write_all(worksheet_xml_from_workbook_sheet(sheet, &styles).as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

fn collect_workbook_styles(sheets: &[SpreadsheetSheet]) -> Vec<SpreadsheetCellStyle> {
    let mut styles = Vec::new();
    for sheet in sheets {
        for row in &sheet.rows {
            for cell in &row.cells {
                if let Some(style) = &cell.style {
                    if !style_is_empty(style) && !styles.iter().any(|item| item == style) {
                        styles.push(style.clone());
                    }
                }
            }
        }
    }
    styles
}

fn workbook_style_id(
    style: &Option<SpreadsheetCellStyle>,
    styles: &[SpreadsheetCellStyle],
) -> usize {
    let Some(style) = style else {
        return 0;
    };
    styles
        .iter()
        .position(|item| item == style)
        .map(|idx| idx + 1)
        .unwrap_or(0)
}

fn xlsx_styles_xml(styles: &[SpreadsheetCellStyle]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    );
    xml.push_str(&format!(r#"<fonts count="{}"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>"#, styles.len() + 1));
    for style in styles {
        xml.push_str("<font>");
        xml.push_str(&format!(
            r#"<sz val="{}"/>"#,
            style.font_size.unwrap_or(11.0)
        ));
        if let Some(color) = &style.color {
            xml.push_str(&format!(
                r#"<color rgb="FF{}"/>"#,
                color.trim_start_matches('#')
            ));
        } else {
            xml.push_str(r#"<color theme="1"/>"#);
        }
        xml.push_str(&format!(
            r#"<name val="{}"/><family val="2"/>"#,
            xml_escape_attr(style.font_family.as_deref().unwrap_or("Calibri"))
        ));
        if style.bold == Some(true) {
            xml.push_str("<b/>");
        }
        if style.italic == Some(true) {
            xml.push_str("<i/>");
        }
        if style.underline == Some(true) {
            xml.push_str("<u/>");
        }
        xml.push_str("</font>");
    }
    xml.push_str("</fonts>");

    xml.push_str(&format!(r#"<fills count="{}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>"#, styles.len() + 2));
    for style in styles {
        if let Some(color) = &style.background_color {
            xml.push_str(&format!(r#"<fill><patternFill patternType="solid"><fgColor rgb="FF{}"/><bgColor indexed="64"/></patternFill></fill>"#, color.trim_start_matches('#')));
        } else {
            xml.push_str(r#"<fill><patternFill patternType="none"/></fill>"#);
        }
    }
    xml.push_str("</fills>");
    xml.push_str(r#"<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>"#);
    xml.push_str(&format!(
        r#"<cellXfs count="{}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#,
        styles.len() + 1
    ));
    for (idx, style) in styles.iter().enumerate() {
        let font_id = idx + 1;
        let fill_id = idx + 2;
        let apply_alignment = style.align.is_some() || style.vertical_align.is_some();
        xml.push_str(&format!(
            r#"<xf numFmtId="0" fontId="{font_id}" fillId="{fill_id}" borderId="0" xfId="0" applyFont="1" applyFill="1"{}>"#,
            if apply_alignment { r#" applyAlignment="1""# } else { "" }
        ));
        if apply_alignment {
            xml.push_str(&format!(
                r#"<alignment horizontal="{}" vertical="{}"/>"#,
                xml_escape_attr(style.align.as_deref().unwrap_or("left")),
                xml_escape_attr(match style.vertical_align.as_deref() {
                    Some("middle") => "center",
                    Some("bottom") => "bottom",
                    _ => "top",
                })
            ));
        }
        xml.push_str("</xf>");
    }
    xml.push_str(r#"</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#);
    xml
}

fn worksheet_xml_from_workbook_sheet(
    sheet: &SpreadsheetSheet,
    styles: &[SpreadsheetCellStyle],
) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    );
    if !sheet.columns.is_empty() {
        xml.push_str("<cols>");
        for col in &sheet.columns {
            if let Some(width) = col.width {
                xml.push_str(&format!(
                    r#"<col min="{}" max="{}" width="{}" customWidth="1"/>"#,
                    col.index, col.index, width
                ));
            }
        }
        xml.push_str("</cols>");
    }
    xml.push_str("<sheetData>");
    let mut rows = sheet.rows.clone();
    rows.sort_by_key(|row| row.index);
    for row in rows {
        xml.push_str(&format!(
            r#"<row r="{}"{}>"#,
            row.index,
            row.height
                .map(|h| format!(r#" ht="{h}" customHeight="1""#))
                .unwrap_or_default()
        ));
        let mut cells = row.cells.clone();
        cells.sort_by_key(|cell| cell.col);
        for cell in cells {
            let reference = format!(
                "{}{}",
                column_name(cell.col as usize),
                cell.row.max(row.index)
            );
            let style_id = workbook_style_id(&cell.style, styles);
            let style_attr = if style_id > 0 {
                format!(r#" s="{style_id}""#)
            } else {
                String::new()
            };
            xml.push_str(&format!(r#"<c r="{reference}" t="inlineStr"{style_attr}>"#));
            if let Some(formula) = &cell.formula {
                xml.push_str(&format!("<f>{}</f>", xml_escape_text(formula)));
            }
            xml.push_str(&format!(
                r#"<is><t xml:space="preserve">{}</t></is></c>"#,
                xml_escape_text(&cell.value)
            ));
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData>");
    if !sheet.merges.is_empty() {
        xml.push_str(&format!(r#"<mergeCells count="{}">"#, sheet.merges.len()));
        for merge in &sheet.merges {
            xml.push_str(&format!(
                r#"<mergeCell ref="{}{}:{}{}"/>"#,
                column_name(merge.start_col as usize),
                merge.start_row,
                column_name(merge.end_col as usize),
                merge.end_row
            ));
        }
        xml.push_str("</mergeCells>");
    }
    xml.push_str("</worksheet>");
    xml
}

fn content_types_xml(sheet_count: usize) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"#,
    );
    for i in 1..=sheet_count {
        xml.push_str(&format!(r#"<Override PartName="/xl/worksheets/sheet{}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#, i));
    }
    xml.push_str("</Types>");
    xml
}

fn workbook_xml(sheets: &[ExportSheet]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>"#,
    );
    for (idx, sheet) in sheets.iter().enumerate() {
        xml.push_str(&format!(
            r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#,
            xml_escape_attr(&sheet.name),
            idx + 1,
            idx + 1
        ));
    }
    xml.push_str("</sheets></workbook>");
    xml
}

fn workbook_rels_xml(sheet_count: usize) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for i in 1..=sheet_count {
        xml.push_str(&format!(r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{}.xml"/>"#, i, i));
    }
    xml.push_str(&format!(r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#, sheet_count + 1));
    xml.push_str("</Relationships>");
    xml
}

fn worksheet_xml(sheet: &ExportSheet) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
    );
    for (row_idx, row) in sheet.rows.iter().enumerate() {
        let r = row_idx + 1;
        xml.push_str(&format!(r#"<row r="{}">"#, r));
        for (col_idx, cell) in row.iter().enumerate() {
            let reference = format!("{}{}", column_name(col_idx + 1), r);
            xml.push_str(&format!(
                r#"<c r="{}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#,
                reference,
                xml_escape_text(cell)
            ));
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData></worksheet>");
    xml
}

fn export_excel_html(content: &str, output_path: &Path) -> anyhow::Result<()> {
    let plain = html_to_plain_text(content);
    let mut html = String::from("<html><head><meta charset=\"utf-8\"></head><body><table border=\"1\" cellspacing=\"0\" cellpadding=\"4\">");
    for line in plain.lines() {
        html.push_str("<tr>");
        for cell in line.split('\t') {
            html.push_str(&format!("<td>{}</td>", html_escape_text(cell)));
        }
        html.push_str("</tr>");
    }
    html.push_str("</table></body></html>");
    fs::write(output_path, html)?;
    Ok(())
}

fn column_name(mut index: usize) -> String {
    let mut name = String::new();
    while index > 0 {
        let rem = (index - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        index = (index - 1) / 26;
    }
    name
}

fn mime_for_file_name(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn html_escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn html_escape_attr(text: &str) -> String {
    html_escape_text(text).replace('"', "&quot;")
}

fn html_unescape(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&emsp;", "\t")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

fn xml_escape_text(text: &str) -> String {
    html_escape_text(text)
}

fn xml_escape_attr(text: &str) -> String {
    xml_escape_text(text).replace('"', "&quot;")
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
        "document_asset".to_string()
    } else {
        trimmed.to_string()
    }
}
