import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRecord, CanvasNode } from '../shared/types';

export interface CompareImageItem {
  node: CanvasNode;
  asset: AssetRecord;
}

function source(asset: AssetRecord) {
  const path = asset.embeddedPreviewDataUrl || asset.embeddedDataUrl || asset.previewPath || asset.projectAssetPath || asset.originalPath;
  return path.startsWith('data:') || path.startsWith('blob:') || path.startsWith('http') ? path : convertFileSrc(path);
}

export function ImageCompareModal({ items, onClose }: { items: [CompareImageItem, CompareImageItem]; onClose: () => void }) {
  const [position, setPosition] = useState(50);
  const [blink, setBlink] = useState(false);
  const [difference, setDifference] = useState(false);
  const [showB, setShowB] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const [zoom, setZoom] = useState(100);
  const cursorRef = useRef<HTMLOutputElement | null>(null);
  const [analysis, setAnalysis] = useState<Array<{ average: string; alpha: number; histogram: number[] }>>([]);
  const urls = useMemo(() => items.map((item) => source(item.asset)) as [string, string], [items]);

  useEffect(() => {
    if (!blink) { setShowB(true); return; }
    const timer = window.setInterval(() => setShowB((value) => !value), 450);
    return () => window.clearInterval(timer);
  }, [blink]);

  useEffect(() => {
    let cancelled = false;
    const analyze = (url: string) => new Promise<{ average: string; alpha: number; histogram: number[] }>((resolve) => {
      const image = new Image(); image.decoding = 'async';
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('No canvas');
          context.drawImage(image, 0, 0, 128, 128);
          const pixels = context.getImageData(0, 0, 128, 128).data; const histogram = Array.from({ length: 16 }, () => 0);
          let red = 0; let green = 0; let blue = 0; let opaque = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2]; if (pixels[index + 3] > 8) opaque += 1;
            histogram[Math.min(15, Math.floor((pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722) / 16))] += 1;
          }
          const count = pixels.length / 4; const hex = (value: number) => Math.round(value / count).toString(16).padStart(2, '0');
          resolve({ average: `#${hex(red)}${hex(green)}${hex(blue)}`.toUpperCase(), alpha: Math.round(opaque / count * 100), histogram });
        } catch { resolve({ average: '不可读取', alpha: 0, histogram: [] }); }
      };
      image.onerror = () => resolve({ average: '读取失败', alpha: 0, histogram: [] }); image.src = url;
    });
    void Promise.all(urls.map(analyze)).then((value) => { if (!cancelled) setAnalysis(value); });
    return () => { cancelled = true; };
  }, [urls]);

  return <div className="image-compare-backdrop" onMouseDown={onClose}>
    <section className="image-compare-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2>图片 A/B 对比</h2><p>滑动分割线，或启用闪烁检查细微差异。</p></div>
        <button onClick={onClose}>关闭</button>
      </header>
      <div className={`image-compare-stage ${checkerboard ? 'checkerboard' : ''}`} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (cursorRef.current) cursorRef.current.value = `${Math.round((event.clientX - rect.left) / rect.width * 100)}%, ${Math.round((event.clientY - rect.top) / rect.height * 100)}%`;
      }}>
        <img src={urls[0]} alt={items[0].node.title || '图片 A'} style={{ transform: `scale(${zoom / 100})` }} />
        {showB && <div className={`image-compare-top ${difference ? 'difference' : ''}`} style={{ clipPath: blink || difference ? 'none' : `inset(0 ${100 - position}% 0 0)` }}>
          <img src={urls[1]} alt={items[1].node.title || '图片 B'} style={{ transform: `scale(${zoom / 100})` }} />
        </div>}
        {!blink && !difference && <div className="image-compare-divider" style={{ left: `${position}%` }}><span>↔</span></div>}
        <output ref={cursorRef} className="image-compare-cursor">50%, 50%</output>
      </div>
      <input aria-label="对比分割位置" type="range" min="0" max="100" value={position} disabled={blink || difference} onChange={(event) => setPosition(Number(event.target.value))} />
      <label className="image-compare-zoom">缩放 <input aria-label="同步缩放" type="range" min="25" max="800" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><output>{zoom}%</output></label>
      <footer>
        <button className={blink ? 'active' : ''} onClick={() => { setBlink((value) => !value); setDifference(false); }}>闪烁对比</button>
        <button className={difference ? 'active' : ''} onClick={() => { setDifference((value) => !value); setBlink(false); }}>差值模式</button>
        <button className={checkerboard ? 'active' : ''} onClick={() => setCheckerboard((value) => !value)}>透明棋盘格</button>
        <span>A：{items[0].asset.name} · {(items[0].asset.fileSize / 1024 / 1024).toFixed(1)} MB</span>
        <span>B：{items[1].asset.name} · {(items[1].asset.fileSize / 1024 / 1024).toFixed(1)} MB</span>
        {analysis.map((item, index) => <span className="image-analysis" key={index}>{index ? 'B' : 'A'} 均色 {item.average} · Alpha 覆盖 {item.alpha}% <i>{item.histogram.map((value, bar) => <b key={bar} style={{ height: `${Math.max(2, value / Math.max(...item.histogram, 1) * 18)}px` }} />)}</i></span>)}
      </footer>
    </section>
  </div>;
}
