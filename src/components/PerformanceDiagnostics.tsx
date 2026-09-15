import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { performanceMetricsSnapshot, subscribePerformanceMetrics } from '../features/performance/performanceMetrics';
import { runCanvasBenchmark, type BenchmarkResult } from '../features/performance/benchmark';

function dataUrlFromText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `data:application/json;base64,${btoa(binary)}`;
}

export function PerformanceDiagnostics() {
  const [metrics, setMetrics] = useState(performanceMetricsSnapshot);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  useEffect(() => {
    const update = () => setMetrics(performanceMetricsSnapshot());
    const unsubscribe = subscribePerformanceMetrics(update);
    const timer = window.setInterval(update, 1000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, []);
  const requests = metrics.imageCacheHits + metrics.imageCacheMisses;
  const hitRate = requests ? Math.round(metrics.imageCacheHits / requests * 100) : 0;
  const qualityName = metrics.qualityTier === 'full' ? '完整' : metrics.qualityTier === 'balanced' ? '均衡' : '流畅优先';

  const exportReport = async () => {
    const path = await save({ defaultPath: `RefMind3D-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path) return;
    const report = {
      generatedAt: new Date().toISOString(),
      appVersion: '1.8.0',
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      metrics,
      cacheHitRate: hitRate,
      benchmark
    };
    await invoke('save_data_url_to_path', { path, dataUrl: dataUrlFromText(JSON.stringify(report, null, 2)) });
  };

  return (
    <section className="performance-diagnostics">
      <div className="settings-section-title"><strong>性能诊断</strong><span>{metrics.fps} FPS · {qualityName}</span></div>
      <div className="performance-metric-grid">
        <span>节点</span><code>{metrics.totalNodes} / 渲染 {metrics.renderedNodes} / 可见 {metrics.visibleNodes}</code>
        <span>帧时间</span><code>{metrics.frameTimeMs} ms · 卡顿帧 {metrics.slowFrames}</code>
        <span>重型资源</span><code>3D {metrics.activeModels} · 视频 {metrics.activeVideos}</code>
        <span>图片队列</span><code>活动 {metrics.imageLoadsActive} · 等待 {metrics.imageLoadsQueued} · 并发 {metrics.imageLoadConcurrency}</code>
        <span>图片清晰度</span><code>缩略 {metrics.imageTierThumbnail} · 中等 {metrics.imageTierMedium} · 预览 {metrics.imageTierPreview} · 原图 {metrics.imageTierFull}</code>
        <span>纹理估算</span><code>{metrics.estimatedTextureMb} MB · 内存缓存 {metrics.imageMemoryEntries} 项</code>
        <span>缓存命中率</span><code>{hitRate}%（{requests} 次）</code>
        <span>源文件刷新</span><code>{metrics.sourceRefreshes} 次</code>
        <span>最近保存</span><code>{metrics.lastSaveMs === undefined ? '尚未记录' : `${metrics.lastSaveMs} ms`}</code>
      </div>
      <div className="performance-benchmark-row">
        <button disabled={benchmarking} onClick={() => {
          setBenchmarking(true);
          void runCanvasBenchmark().then(setBenchmark).finally(() => setBenchmarking(false));
        }}>{benchmarking ? '正在测试…' : '运行 10,000 节点基准'}</button>
        <button onClick={() => void exportReport()}>导出诊断报告</button>
        {benchmark && <code>索引 {benchmark.buildMs} ms · 查询 {benchmark.queryMs} ms · 120 帧合成 {benchmark.transformMs} ms · 平均 {benchmark.averageHits} 节点</code>}
      </div>
    </section>
  );
}
