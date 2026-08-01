import { invoke } from '@tauri-apps/api/core';
import type { ImportedImage, ImportedModel, ImportedVideo } from '../../shared/types';

export async function importImageAsset(sourcePath: string, projectRoot: string): Promise<ImportedImage> {
  return invoke<ImportedImage>('import_image_asset', { sourcePath, projectRoot });
}

export async function importClipboardImageDataUrl(dataUrl: string): Promise<ImportedImage> {
  return invoke<ImportedImage>('import_clipboard_image_data_url', { dataUrl });
}

export async function importRemoteImageAsset(sourceUrl: string, referer?: string): Promise<ImportedImage> {
  return invoke<ImportedImage>('import_remote_image_asset', { sourceUrl, referer });
}

export async function registerRuntimeAsset(dataUrl: string, nameHint?: string): Promise<ImportedImage> {
  return invoke<ImportedImage>('register_runtime_asset', { dataUrl, nameHint });
}

export async function registerRuntimeVideoAsset(dataUrl: string, nameHint: string): Promise<ImportedVideo> {
  return invoke<ImportedVideo>('register_runtime_video_asset', { dataUrl, nameHint });
}

export async function registerRuntimeModelAsset(dataUrl: string, nameHint: string): Promise<ImportedModel> {
  return invoke<ImportedModel>('register_runtime_model_asset', { dataUrl, nameHint });
}

export async function registerRuntimeDocumentAsset(dataUrl: string, nameHint: string) {
  return invoke('register_runtime_document_asset', { dataUrl, nameHint });
}

export async function importModelAsset(sourcePath: string, projectRoot: string): Promise<ImportedModel> {
  return invoke<ImportedModel>('inspect_model_asset', { sourcePath, projectRoot });
}

export async function importVideoAsset(sourcePath: string, projectRoot: string): Promise<ImportedVideo> {
  return invoke<ImportedVideo>('import_video_asset', { sourcePath, projectRoot });
}

export async function importDocumentAsset(sourcePath: string, projectRoot: string) {
  return invoke('import_document_asset', { sourcePath, projectRoot });
}

export async function convertModelToObj(sourcePath: string, outputPath: string): Promise<string> {
  return invoke<string>('convert_model_to_obj', { sourcePath, outputPath });
}

export async function exportEditableDocumentAsset(format: string, content: string, outputPath: string): Promise<void> {
  await invoke('export_editable_document_asset', { format, content, outputPath });
}
