import { memo, useEffect, useRef } from 'react';
import { updatePerformanceMetrics } from '../performance/performanceMetrics';

export interface GpuImageItem {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  grayscale: boolean;
}

const vertexSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_texCoord = a_texCoord; }
`;
const fragmentSource = `
precision mediump float;
uniform sampler2D u_image;
uniform float u_opacity;
uniform float u_grayscale;
varying vec2 v_texCoord;
void main() { vec4 color = texture2D(u_image, v_texCoord); float luma = dot(color.rgb, vec3(.2126, .7152, .0722)); color.rgb = mix(color.rgb, vec3(luma), u_grayscale); gl_FragColor = vec4(color.rgb, color.a * u_opacity); }
`;

function shader(gl: WebGLRenderingContext, type: number, source: string) {
  const value = gl.createShader(type);
  if (!value) return null;
  gl.shaderSource(value, source); gl.compileShader(value);
  return gl.getShaderParameter(value, gl.COMPILE_STATUS) ? value : null;
}

export const GpuImageLayer = memo(function GpuImageLayer({ items, width, height, onSupportChange }: {
  items: GpuImageItem[];
  width: number;
  height: number;
  onSupportChange: (supported: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const itemsRef = useRef(items);
  const sizeRef = useRef({ width, height });
  const runtimeRef = useRef<{
    gl: WebGLRenderingContext; program: WebGLProgram; vertex: WebGLShader; fragment: WebGLShader;
    positionBuffer: WebGLBuffer; textureBuffer: WebGLBuffer; positionLocation: number; textureLocation: number;
    opacityLocation: WebGLUniformLocation | null; grayscaleLocation: WebGLUniformLocation | null;
    textures: Map<string, WebGLTexture>; loading: Set<string>;
  } | null>(null);
  const redrawRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', { alpha: true, antialias: false, depth: false, preserveDrawingBuffer: false });
    if (!canvas || !gl) { onSupportChange(false); return; }
    onSupportChange(true);
    const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) { onSupportChange(false); return; }
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program); gl.useProgram(program);
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const textureLocation = gl.getAttribLocation(program, 'a_texCoord');
    const opacityLocation = gl.getUniformLocation(program, 'u_opacity');
    const grayscaleLocation = gl.getUniformLocation(program, 'u_grayscale');
    const positionBuffer = gl.createBuffer();
    const textureBuffer = gl.createBuffer();
    if (!positionBuffer || !textureBuffer) { onSupportChange(false); return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, textureBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(textureLocation); gl.vertexAttribPointer(textureLocation, 2, gl.FLOAT, false, 0, 0);
    const textures = new Map<string, WebGLTexture>();
    const loading = new Set<string>();
    runtimeRef.current = { gl, program, vertex, fragment, positionBuffer, textureBuffer, positionLocation, textureLocation, opacityLocation, grayscaleLocation, textures, loading };
    gl.clearColor(0, 0, 0, 0);
    redrawRef.current = () => {
      const runtime = runtimeRef.current; if (!runtime) return;
      const size = sizeRef.current; runtime.gl.viewport(0, 0, canvas.width, canvas.height); runtime.gl.clear(runtime.gl.COLOR_BUFFER_BIT);
      for (const item of itemsRef.current) {
        const texture = runtime.textures.get(item.src); if (!texture) continue;
        const centerX = item.x + item.width / 2; const centerY = item.y + item.height / 2;
      const radians = item.rotation * Math.PI / 180;
      const cos = Math.cos(radians); const sin = Math.sin(radians);
      const point = (localX: number, localY: number) => {
        const px = centerX + localX * cos - localY * sin;
        const py = centerY + localX * sin + localY * cos;
          return [px / size.width * 2 - 1, 1 - py / size.height * 2];
      };
      const tl = point(-item.width / 2, -item.height / 2); const tr = point(item.width / 2, -item.height / 2);
      const bl = point(-item.width / 2, item.height / 2); const br = point(item.width / 2, item.height / 2);
        runtime.gl.bindBuffer(runtime.gl.ARRAY_BUFFER, runtime.positionBuffer);
        runtime.gl.bufferData(runtime.gl.ARRAY_BUFFER, new Float32Array([...tl, ...tr, ...bl, ...bl, ...tr, ...br]), runtime.gl.STREAM_DRAW);
        runtime.gl.enableVertexAttribArray(runtime.positionLocation); runtime.gl.vertexAttribPointer(runtime.positionLocation, 2, runtime.gl.FLOAT, false, 0, 0);
      const leftU = item.flipX ? 1 : 0; const rightU = item.flipX ? 0 : 1;
      const topV = item.flipY ? 1 : 0; const bottomV = item.flipY ? 0 : 1;
        runtime.gl.bindBuffer(runtime.gl.ARRAY_BUFFER, runtime.textureBuffer);
        runtime.gl.bufferData(runtime.gl.ARRAY_BUFFER, new Float32Array([leftU, topV, rightU, topV, leftU, bottomV, leftU, bottomV, rightU, topV, rightU, bottomV]), runtime.gl.STREAM_DRAW);
        runtime.gl.enableVertexAttribArray(runtime.textureLocation); runtime.gl.vertexAttribPointer(runtime.textureLocation, 2, runtime.gl.FLOAT, false, 0, 0);
        runtime.gl.bindTexture(runtime.gl.TEXTURE_2D, texture); runtime.gl.uniform1f(runtime.opacityLocation, item.opacity); runtime.gl.uniform1f(runtime.grayscaleLocation, item.grayscale ? 1 : 0); runtime.gl.drawArrays(runtime.gl.TRIANGLES, 0, 6);
      }
    };
    redrawRef.current();
    return () => {
      textures.forEach((texture) => gl.deleteTexture(texture));
      gl.deleteBuffer(positionBuffer); gl.deleteBuffer(textureBuffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
      runtimeRef.current = null; updatePerformanceMetrics({ gpuTextureCount: 0 });
    };
  }, [onSupportChange]);

  useEffect(() => {
    itemsRef.current = items; sizeRef.current = { width, height };
    const runtime = runtimeRef.current; if (!runtime) return;
    for (const item of items) {
      if (runtime.textures.has(item.src) || runtime.loading.has(item.src)) continue;
      runtime.loading.add(item.src);
      const image = new Image();
      image.onload = () => {
        const current = runtimeRef.current; if (!current) return;
        current.loading.delete(item.src);
        const texture = current.gl.createTexture();
        if (!texture) return;
        current.gl.bindTexture(current.gl.TEXTURE_2D, texture);
        current.gl.texParameteri(current.gl.TEXTURE_2D, current.gl.TEXTURE_WRAP_S, current.gl.CLAMP_TO_EDGE); current.gl.texParameteri(current.gl.TEXTURE_2D, current.gl.TEXTURE_WRAP_T, current.gl.CLAMP_TO_EDGE);
        current.gl.texParameteri(current.gl.TEXTURE_2D, current.gl.TEXTURE_MIN_FILTER, current.gl.LINEAR); current.gl.texParameteri(current.gl.TEXTURE_2D, current.gl.TEXTURE_MAG_FILTER, current.gl.LINEAR);
        current.gl.texImage2D(current.gl.TEXTURE_2D, 0, current.gl.RGBA, current.gl.RGBA, current.gl.UNSIGNED_BYTE, image);
        current.textures.set(item.src, texture);
        while (current.textures.size > 256) {
          const oldest = current.textures.entries().next().value as [string, WebGLTexture] | undefined;
          if (!oldest) break;
          current.gl.deleteTexture(oldest[1]); current.textures.delete(oldest[0]);
        }
        updatePerformanceMetrics({ gpuTextureCount: current.textures.size }); redrawRef.current();
      };
      image.onerror = () => runtimeRef.current?.loading.delete(item.src);
      image.src = item.src;
    }
    redrawRef.current();
  }, [height, items, width]);
  return <canvas ref={canvasRef} className="gpu-image-layer" width={Math.max(1, Math.round(width))} height={Math.max(1, Math.round(height))} aria-hidden="true" />;
});
