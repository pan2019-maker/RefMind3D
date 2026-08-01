import type { CanvasNode } from './types';

export const FREE_TEXT_PLACEHOLDER = '双击输入文本';
export const FREE_TEXT_FONT_FAMILY = 'SimHei, Microsoft YaHei, Heiti SC, Segoe UI, sans-serif';

export function freeTextNodeSize(text: string, node: Pick<CanvasNode, 'fontSize' | 'fontFamily' | 'fontWeight' | 'fontStyle'>) {
  const fontSize = Math.max(1, node.fontSize || 22);
  const fontFamily = node.fontFamily || FREE_TEXT_FONT_FAMILY;
  const fontWeight = node.fontWeight || 'normal';
  const fontStyle = node.fontStyle || 'normal';
  const lineHeight = fontSize * 1.22;
  const lines = (text.trim().length ? text : FREE_TEXT_PLACEHOLDER).split('\n');
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const context = canvas?.getContext('2d');
  let maxWidth = fontSize * 2;
  if (context) {
    context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    maxWidth = Math.max(...lines.map((line) => context.measureText(line || ' ').width));
  } else {
    maxWidth = Math.max(...lines.map((line) => Math.max(1, line.length) * fontSize));
  }

  // PureRef-style free text uses a tight, transparent box. Keep measurement and
  // CSS padding in em units so the frame and glyphs scale as one object.
  const horizontalPadding = fontSize * 0.2;
  const verticalPadding = fontSize * 0.16;
  return {
    width: Math.max(24, Math.ceil(maxWidth + horizontalPadding)),
    height: Math.max(18, Math.ceil(lines.length * lineHeight + verticalPadding))
  };
}
