import { memo, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

interface ModelViewerProps {
  modelPath: string;
  modelFormat?: string;
  compact?: boolean;
  onPreviewReady?: (dataUrl: string) => void;
}

type DisplayMode = 'material' | 'gray' | 'white' | 'wireframe';

function disposeObject(object: THREE.Object3D) {
  object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value && typeof value === 'object' && 'isTexture' in value) {
      (value as THREE.Texture).dispose();
    }
  });
  material.dispose();
}

function fitCameraToObject(camera: THREE.PerspectiveCamera, controls: OrbitControls, object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const fov = camera.fov * (Math.PI / 180);
  const cameraZ = Math.abs(maxDim / Math.sin(fov / 2));
  camera.position.set(center.x, center.y, center.z + cameraZ * 1.15);
  camera.near = Math.max(0.001, cameraZ / 1000);
  camera.far = cameraZ * 1000;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  return { center, radius: maxDim / 2, distance: cameraZ * 1.15 };
}

function isRuntimeResourceUrl(path: string) {
  return path.startsWith('refmind3d://')
    || path.startsWith('http://refmind3d.localhost')
    || path.startsWith('https://refmind3d.localhost');
}

function modelUrlForLoader(path: string) {
  return path.startsWith('data:') || path.startsWith('blob:') || isRuntimeResourceUrl(path)
    ? path
    : convertFileSrc(path);
}

function modelFormatFromPath(path: string, explicitFormat?: string) {
  const normalizedFormat = explicitFormat?.trim().toLowerCase();
  if (normalizedFormat) return normalizedFormat;
  const embeddedFormatMatch = path.match(/^data:[^;]+\/([^;,+]+)/);
  if (embeddedFormatMatch?.[1]) {
    const format = embeddedFormatMatch[1].toLowerCase();
    if (format === 'gltf-binary') return 'glb';
    if (format === 'gltf+json') return 'gltf';
    if (format !== 'octet-stream') return format;
  }
  return path.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
}

export const ModelViewer = memo(function ModelViewer({ modelPath, modelFormat, compact = false, onPreviewReady }: ModelViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState('准备加载模型');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('material');
  const [lightInfo, setLightInfo] = useState('天光 0°');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    cleanupRef.current?.();
    setStatus('加载中...');

    const width = container.clientWidth || 400;
    const height = container.clientHeight || 260;
    const scene = new THREE.Scene();
    scene.background = compact ? null : new THREE.Color(0x111318);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
    camera.position.set(0, 1, 5);

    const renderer = new THREE.WebGLRenderer({
      antialias: !compact,
      alpha: compact,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: compact && Boolean(onPreviewReady)
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, compact ? 1.5 : 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enabled = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    controls.minDistance = 0.001;
    controls.maxDistance = 100000;

    const skyLight = new THREE.HemisphereLight(0xffffff, 0x566070, compact ? 1.15 : 1.55);
    const lightRig = new THREE.Group();
    const keyLight = new THREE.DirectionalLight(0xffffff, compact ? 2.0 : 2.8);
    keyLight.position.set(5, 7, 8);
    const fillLight = new THREE.DirectionalLight(0xbfd7ff, compact ? 0.55 : 0.85);
    fillLight.position.set(-6, 4, -5);
    lightRig.add(keyLight, fillLight);
    scene.add(skyLight, lightRig);
    let lightAzimuth = 0;
    setLightInfo('天光 0°');

    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x3e4657, wireframe: true })
    );
    scene.add(placeholder);

    let framePending = false;
    let disposed = false;
    let loaded: THREE.Object3D | null = null;
    let modelCenter = new THREE.Vector3(0, 0, 0);
    let modelRadius = 1;
    let animationFrame = 0;
    let previewCaptured = false;

    const renderOnce = () => {
      if (disposed || framePending) return;
      framePending = true;
      requestAnimationFrame(() => {
        framePending = false;
        controls.update();
        renderer.render(scene, camera);
      });
    };

    let lightDrag: { pointerId: number; startX: number; startAngle: number } | null = null;
    const updateLightAngle = (angle: number) => {
      lightAzimuth = angle;
      lightRig.rotation.y = angle;
      const degrees = Math.round(((angle * 180 / Math.PI) % 360 + 360) % 360);
      setLightInfo(`天光 ${degrees}°`);
      renderOnce();
    };
    const onLightPointerDown = (event: PointerEvent) => {
      if (compact || !event.shiftKey || event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      lightDrag = { pointerId: event.pointerId, startX: event.clientX, startAngle: lightAzimuth };
      controls.enabled = false;
      renderer.domElement.setPointerCapture?.(event.pointerId);
      setStatus('Shift + 右键拖拽：横向旋转天光');
    };
    const onLightPointerMove = (event: PointerEvent) => {
      if (!lightDrag || event.pointerId !== lightDrag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (event.clientX - lightDrag.startX) * 0.012;
      updateLightAngle(lightDrag.startAngle + delta);
    };
    const onLightPointerUp = (event: PointerEvent) => {
      if (!lightDrag || event.pointerId !== lightDrag.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      renderer.domElement.releasePointerCapture?.(event.pointerId);
      lightDrag = null;
      controls.enabled = true;
      setStatus('已加载：左键按模型中心旋转，中键平移，Shift + 右键拖拽可旋转天光');
      renderOnce();
    };

    renderer.domElement.addEventListener('pointerdown', onLightPointerDown, true);
    renderer.domElement.addEventListener('pointermove', onLightPointerMove, true);
    renderer.domElement.addEventListener('pointerup', onLightPointerUp, true);
    renderer.domElement.addEventListener('pointercancel', onLightPointerUp, true);
    const preventViewerContextMenu = (event: Event) => event.preventDefault();
    renderer.domElement.addEventListener('contextmenu', preventViewerContextMenu);

    controls.addEventListener('change', renderOnce);
    if (compact) {
      renderOnce();
    } else {
      const animate = () => {
        if (disposed) return;
        animationFrame = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();
    }

    const onResize = () => {
      const nextWidth = Math.max(1, Math.round(container.clientWidth || 400));
      const nextHeight = Math.max(1, Math.round(container.clientHeight || 260));
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight, false);
      // 画布里的紧凑 3D 视口在节点被等比放大/缩小时不会触发 window.resize，
      // 所以必须监听容器本身尺寸；同时重新确认 OrbitControls 的目标点在模型中心。
      controls.target.copy(modelCenter);
      controls.update();
      renderOnce();
    };
    window.addEventListener('resize', onResize);
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    const url = modelUrlForLoader(modelPath);
    const ext = modelFormatFromPath(modelPath, modelFormat);

    const applyMode = (object: THREE.Object3D, mode: DisplayMode) => {
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mode === 'wireframe') {
          mesh.material = new THREE.MeshBasicMaterial({ color: 0xd9dee8, wireframe: true });
        } else if (mode === 'gray') {
          mesh.material = new THREE.MeshStandardMaterial({ color: 0x7a7d82, roughness: 0.95, metalness: 0.0 });
        } else if (mode === 'white') {
          mesh.material = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.95, metalness: 0.0 });
        }
      });
    };

    const finishLoad = (object: THREE.Object3D) => {
      if (disposed) {
        disposeObject(object);
        return;
      }
      scene.remove(placeholder);
      placeholder.geometry.dispose();
      (placeholder.material as THREE.Material).dispose();
      loaded = object;
      applyMode(object, displayMode);
      scene.add(object);
      const fitted = fitCameraToObject(camera, controls, object);
      modelCenter = fitted.center.clone();
      modelRadius = fitted.radius;
      if (compact && onPreviewReady && !previewCaptured) {
        previewCaptured = true;
        requestAnimationFrame(() => {
          if (disposed) return;
          controls.update();
          renderer.render(scene, camera);
          try {
            const source = renderer.domElement;
            const scale = Math.min(1, 640 / Math.max(source.width, source.height, 1));
            const snapshot = document.createElement('canvas');
            snapshot.width = Math.max(1, Math.round(source.width * scale));
            snapshot.height = Math.max(1, Math.round(source.height * scale));
            snapshot.getContext('2d')?.drawImage(source, 0, 0, snapshot.width, snapshot.height);
            const dataUrl = snapshot.toDataURL('image/webp', 0.82);
            if (dataUrl.length > 128) onPreviewReady(dataUrl);
          } catch {
            // Keep the live viewer when this WebView cannot capture WebGL output.
          }
        });
      }
      setStatus(compact ? '已加载，可直接 360° 预览，双击放大；拖动标题条移动窗口' : '已加载：左键按模型中心旋转，中键平移，Shift + 右键拖动天光');
      renderOnce();
    };

    const failLoad = (error: unknown) => {
      console.error(error);
      setStatus('模型加载失败：文件可能损坏、贴图缺失或格式不完整');
      renderOnce();
    };

    if (ext === 'glb' || ext === 'gltf') {
      new GLTFLoader().load(url, (gltf) => finishLoad(gltf.scene), undefined, failLoad);
    } else if (ext === 'obj') {
      new OBJLoader().load(url, finishLoad, undefined, failLoad);
    } else if (ext === 'fbx') {
      new FBXLoader().load(url, finishLoad, undefined, failLoad);
    } else {
      setStatus('当前模型格式暂不支持预览');
    }

    cleanupRef.current = () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      controls.removeEventListener('change', renderOnce);
      renderer.domElement.removeEventListener('pointerdown', onLightPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', onLightPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', onLightPointerUp, true);
      renderer.domElement.removeEventListener('pointercancel', onLightPointerUp, true);
      renderer.domElement.removeEventListener('contextmenu', preventViewerContextMenu);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      controls.dispose();
      if (loaded) disposeObject(loaded);
      scene.remove(...scene.children);
      renderer.setAnimationLoop(null);
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };

    return () => cleanupRef.current?.();
  }, [modelPath, modelFormat, compact, displayMode, onPreviewReady]);

  return (
    <div className={`model-viewer ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="viewer-toolbar">
          <button onClick={() => setDisplayMode('material')}>材质</button>
          <button onClick={() => setDisplayMode('gray')}>灰模</button>
          <button onClick={() => setDisplayMode('white')}>白模</button>
          <button onClick={() => setDisplayMode('wireframe')}>线框</button>
          <span>{status} · {lightInfo}</span>
        </div>
      )}
      <div className="viewer-canvas" ref={containerRef} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} />
      {compact && <span className="compact-status">{status}</span>}
    </div>
  );
});
