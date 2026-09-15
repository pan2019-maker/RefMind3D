export type AssetKind = 'image' | 'model' | 'video' | 'document' | 'table' | 'pdf';
export type ImageFormat =
  | 'png' | 'jpg' | 'jpeg' | 'webp' | 'bmp' | 'gif' | 'ico'
  | 'svg'
  | 'tif' | 'tiff' | 'tga' | 'dds' | 'hdr' | 'exr' | 'avif' | 'qoi'
  | 'psd' | 'psb' | 'unknown';
export type ModelFormat = 'obj' | 'fbx' | 'glb' | 'gltf' | 'unknown';
export type VideoFormat = 'mp4' | 'avi' | 'mov' | 'mkv' | 'webm' | 'm4v' | 'wmv' | 'flv' | 'ogg' | 'ogv' | '3gp' | 'unknown';
export type DocumentFormat = 'txt' | 'md' | 'rtf' | 'doc' | 'docx' | 'pdf' | 'csv' | 'tsv' | 'xls' | 'xlsx' | 'unknown';

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  name: string;
  originalPath: string;
  projectAssetPath: string;
  previewPath?: string;
  thumbnailPath?: string;
  embeddedDataUrl?: string;
  embeddedPreviewDataUrl?: string;
  embeddedThumbnailDataUrl?: string;
  fileSize: number;
  format: string;
  importedAt: string;
  /** Stable source/content identity used to avoid embedding the same asset twice. */
  contentHash?: string;
  extractedText?: string;
  contentHtml?: string;
  documentMedia?: DocumentMedia[];
  spreadsheetData?: SpreadsheetWorkbook;
  /** Embedded keeps a portable copy in the project; linked keeps the source path. */
  storageMode?: 'embedded' | 'linked';
  /** Linked files refresh their decoded cache when size or modification time changes. */
  autoRefresh?: boolean;
  /** User-defined labels shared by every node that references this asset. */
  tags?: string[];
}

export interface DocumentMedia {
  id: string;
  name: string;
  mime: string;
  path: string;
}

export interface ImportedImage extends AssetRecord {
  kind: 'image';
  width: number;
  height: number;
  channels?: number;
}

export interface ImportedDocument extends AssetRecord {
  kind: 'document' | 'table' | 'pdf';
  extractedText: string;
}

export interface SpreadsheetWorkbook {
  kind: 'spreadsheet-workbook';
  activeSheetIndex: number;
  sheets: SpreadsheetSheet[];
}

export interface SpreadsheetSheet {
  id: string;
  name: string;
  rows: SpreadsheetRow[];
  columns?: SpreadsheetColumn[];
  merges?: SpreadsheetMerge[];
}

export interface SpreadsheetRow {
  index: number;
  height?: number;
  cells: SpreadsheetCell[];
}

export interface SpreadsheetColumn {
  index: number;
  width?: number;
}

export interface SpreadsheetMerge {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface SpreadsheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
}

export interface SpreadsheetCell {
  row: number;
  col: number;
  value: string;
  formula?: string;
  style?: SpreadsheetCellStyle;
}

export interface ModelStats {
  vertices?: number;
  faces?: number;
  materials?: number;
  textures?: number;
  fileSize: number;
  bbox?: [number, number, number];
  warningLevel: 'ok' | 'large' | 'extreme' | 'unknown';
  warnings: string[];
}

export interface ImportedModel extends AssetRecord {
  kind: 'model';
  stats: ModelStats;
}

export interface ImportedVideo extends AssetRecord {
  kind: 'video';
  width?: number;
  height?: number;
  duration?: number;
}

export type CanvasNodeType = 'image' | 'model' | 'video' | 'note' | 'mindmap' | 'group' | 'document' | 'table' | 'pdf';
export type FontWeightValue = 'normal' | 'bold';
export type FontStyleValue = 'normal' | 'italic';
export type TextDecorationValue = 'none' | 'underline';

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  assetId?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  text?: string;
  fillColor?: string;
  strokeColor?: string;
  textColor?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeightValue;
  fontStyle?: FontStyleValue;
  textDecoration?: TextDecorationValue;
  richTextHtml?: string;
  spreadsheetData?: SpreadsheetWorkbook;
  groupId?: string;
  /** True for PureRef-style content groups; false keeps a drawing box independent. */
  isGroupContainer?: boolean;
  /** Content groups are locked by default and require double click to edit inside. */
  groupLocked?: boolean;
  locked?: boolean;
  hidden?: boolean;
  opacity?: number;
  grayscale?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  lockAspectRatio?: boolean;
  /** Searchable labels local to this node. */
  tags?: string[];
  /** Non-destructive image framing controls. The node rectangle is the crop frame. */
  cropEnabled?: boolean;
  imageScale?: number;
  imagePanX?: number;
  imagePanY?: number;
}

export interface MindLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  color: string;
  width: number;
}

export interface DoodlePoint {
  x: number;
  y: number;
  pressure: number;
}

export type DoodleTool = 'brush' | 'arrow' | 'rectangle' | 'ellipse';

export interface DoodleStroke {
  id: string;
  tool?: DoodleTool;
  color: string;
  width: number;
  points: DoodlePoint[];
}

export interface RefMindProject {
  version: 1;
  cacheId?: string;
  cacheDirectory?: string;
  /** Folders watched for newly added supported assets. */
  sourceFolders?: string[];
  name: string;
  rootPath?: string;
  assets: AssetRecord[];
  nodes: CanvasNode[];
  links: MindLink[];
  doodles?: DoodleStroke[];
  canvasLocked?: boolean;
  canvasGrayscale?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasWorkspaceRecord {
  id: string;
  name: string;
  project: RefMindProject;
  lazy?: boolean;
}

export interface RefMindWorkspaceFile {
  version: 2;
  cacheId?: string;
  cacheDirectory?: string;
  fileType: 'refmind3d-workspace';
  name: string;
  activeCanvasId: string;
  canvases: CanvasWorkspaceRecord[];
  createdAt: string;
  updatedAt: string;
}

export type RefMindProjectFile = RefMindProject | RefMindWorkspaceFile;
