import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { performanceMetricsSnapshot, subscribePerformanceMetrics } from '../features/performance/performanceMetrics';
import { runCanvasBenchmarkSuite, type BenchmarkResult } from '../features/performance/benchmark';
import { crashSessionStatus, errorJournalSnapshot } from '../features/diagnostics/errorJournal';
import { useProjectStore } from '../stores/projectStore';

type IntegrityReport = { valid: boolean; canvasCount: number; resourceCount: number; checkedEntries: number; sizeBytes: number };
type UpdateInfo = { version: string; releaseUrl: string; installerUrl?: string; sha256?: string };

function dataUrlFromText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `data:application/json;base64,${btoa(binary)}`;
}

export function PerformanceDiagnostics({ projectPath }: { projectPath?: string }) {
  const [metrics, setMetrics] = useState(performanceMetricsSnapshot);
  const project = useProjectStore((state) => state.project);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [benchmarkSuite, setBenchmarkSuite] = useState<BenchmarkResult[]>([]);
  const [benchmarking, setBenchmarking] = useState(false);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
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
      appVersion: '1.15.0',
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      devicePixelRatio: window.devicePixelRatio,
      metrics,
      cacheHitRate: hitRate,
      benchmark,
      integrity,
      projectSummary: { nodes: project.nodes.length, assets: project.assets.length, links: project.links.length, doodles: project.doodles?.length || 0 },
      recentErrors: errorJournalSnapshot(),
      crashSession: crashSessionStatus()
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
        <span>GPU / 输入延迟</span><code>纹理 {metrics.gpuTextureCount} · P95 {metrics.inputLatencyP95Ms} ms</code>
        <span>内存硬保护</span><code>{metrics.memoryPressure ? '已触发降载' : '正常'} · JS {metrics.jsHeapMb || '—'} MB · 共 {metrics.resourceProtectionActivations} 次</code>
        <span>显示缩放</span><code>{Math.round(window.devicePixelRatio * 100)}%（DPR {window.devicePixelRatio}）</code>
        <span>缓存命中率</span><code>{hitRate}%（{requests} 次）</code>
        <span>源文件刷新</span><code>{metrics.sourceRefreshes} 次</code>
        <span>最近保存</span><code>{metrics.lastSaveMs === undefined ? '尚未记录' : `${metrics.lastSaveMs} ms`}</code>
        <span>崩溃诊断</span><code>{crashSessionStatus().previousSessionUnclean ? '上次会话可能异常结束' : '正常'} · 本地日志 {crashSessionStatus().persistedErrors} 条</code>
        <span>最近工程打开</span><code>{metrics.projectOpenMs === undefined ? '尚未记录' : `${metrics.projectOpenMs} ms（索引与当前画布）`}</code>
      </div>
      <div className="performance-benchmark-row">
        <button disabled={benchmarking} onClick={() => {
          setBenchmarking(true);
          void runCanvasBenchmarkSuite().then((results) => {
            setBenchmarkSuite(results);
            setBenchmark(results[results.length - 1]);
            localStorage.setItem('refmind3d.performance-baseline.v1', JSON.stringify({ at: new Date().toISOString(), results }));
          }).finally(() => setBenchmarking(false));
        }}>{benchmarking ? '正在测试…' : '运行 1K / 5K / 10K 稳定基准'}</button>
        <button onClick={() => void exportReport()}>导出诊断报告</button>
        <button disabled={!projectPath || checking} onClick={() => {
          if (!projectPath) return;
          setChecking(true); void invoke<IntegrityReport>('validate_project_package', { path: projectPath }).then(setIntegrity).finally(() => setChecking(false));
        }}>{checking ? '正在校验…' : '校验当前工程包'}</button>
        <button disabled={checking} onClick={() => {
          setChecking(true); void invoke<UpdateInfo>('check_for_update').then(setUpdateInfo).finally(() => setChecking(false));
        }}>检查更新</button>
        {integrity && <code>工程包完整：{integrity.canvasCount} 画布 · {integrity.resourceCount} 资源 · 已校验 {integrity.checkedEntries} 项</code>}
        {updateInfo && <code>最新版本 {updateInfo.version} · <a href={updateInfo.releaseUrl} target="_blank" rel="noreferrer">打开官方下载页</a>{updateInfo.sha256 ? ` · SHA-256 ${updateInfo.sha256.slice(0, 12)}…` : ''}</code>}
        {benchmark && <code>索引 {benchmark.buildMs} ms · 查询 {benchmark.queryMs} ms · 120 帧合成 {benchmark.transformMs} ms · 千张 8K 瓦片调度 {benchmark.tileSelectionMs} ms · {benchmark.soakCycles} 轮稳定性 {benchmark.soakMs} ms · 压力估算 {benchmark.estimatedPeakMb} MB</code>}
        {benchmarkSuite.length > 0 && <code>{benchmarkSuite.map((item) => `${item.nodeCount / 1000}K：索引 ${item.buildMs}ms / 查询 ${item.queryMs}ms / 稳定 ${item.soakMs}ms`).join(' · ')}</code>}
      </div>
    </section>
  );
}
