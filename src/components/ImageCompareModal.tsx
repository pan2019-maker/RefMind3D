import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
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
  const [showB, setShowB] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const urls = useMemo(() => items.map((item) => source(item.asset)) as [string, string], [items]);

  useEffect(() => {
    if (!blink) { setShowB(true); return; }
    const timer = window.setInterval(() => setShowB((value) => !value), 450);
    return () => window.clearInterval(timer);
  }, [blink]);

  return <div className="image-compare-backdrop" onMouseDown={onClose}>
    <section className="image-compare-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2>图片 A/B 对比</h2><p>滑动分割线，或启用闪烁检查细微差异。</p></div>
        <button onClick={onClose}>关闭</button>
      </header>
      <div className={`image-compare-stage ${checkerboard ? 'checkerboard' : ''}`}>
        <img src={urls[0]} alt={items[0].node.title || '图片 A'} />
        {showB && <div className="image-compare-top" style={{ clipPath: blink ? 'none' : `inset(0 ${100 - position}% 0 0)` }}>
          <img src={urls[1]} alt={items[1].node.title || '图片 B'} />
        </div>}
        {!blink && <div className="image-compare-divider" style={{ left: `${position}%` }}><span>↔</span></div>}
      </div>
      <input aria-label="对比分割位置" type="range" min="0" max="100" value={position} disabled={blink} onChange={(event) => setPosition(Number(event.target.value))} />
      <footer>
        <button className={blink ? 'active' : ''} onClick={() => setBlink((value) => !value)}>闪烁对比</button>
        <button className={checkerboard ? 'active' : ''} onClick={() => setCheckerboard((value) => !value)}>透明棋盘格</button>
        <span>A：{items[0].asset.name} · {(items[0].asset.fileSize / 1024 / 1024).toFixed(1)} MB</span>
        <span>B：{items[1].asset.name} · {(items[1].asset.fileSize / 1024 / 1024).toFixed(1)} MB</span>
      </footer>
    </section>
  </div>;
}
