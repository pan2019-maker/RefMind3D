import { useEffect, useState } from 'react';
import { performanceMetricsSnapshot, subscribePerformanceMetrics } from '../features/performance/performanceMetrics';

export function PerformanceDiagnostics() {
  const [metrics, setMetrics] = useState(performanceMetricsSnapshot);
  useEffect(() => {
    const update = () => setMetrics(performanceMetricsSnapshot());
    const unsubscribe = subscribePerformanceMetrics(update);
    const timer = window.setInterval(update, 1000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, []);
  const requests = metrics.imageCacheHits + metrics.imageCacheMisses;
  const hitRate = requests ? Math.round(metrics.imageCacheHits / requests * 100) : 0;
  return (
    <section className="performance-diagnostics">
      <div className="settings-section-title"><strong>性能诊断</strong><span>{metrics.fps} FPS</span></div>
      <div className="performance-metric-grid">
        <span>节点</span><code>{metrics.totalNodes} / 渲染 {metrics.renderedNodes} / 可见 {metrics.visibleNodes}</code>
        <span>重型资源</span><code>3D {metrics.activeModels} · 视频 {metrics.activeVideos}</code>
        <span>图片队列</span><code>活动 {metrics.imageLoadsActive} · 等待 {metrics.imageLoadsQueued}</code>
        <span>图片内存缓存</span><code>{metrics.imageMemoryEntries} 项</code>
        <span>缓存命中率</span><code>{hitRate}%（{requests} 次）</code>
        <span>卡顿帧</span><code>{metrics.slowFrames}</code>
        <span>最近保存</span><code>{metrics.lastSaveMs === undefined ? '尚未记录' : `${metrics.lastSaveMs} ms`}</code>
      </div>
    </section>
  );
}
