import { memo, useEffect, useRef } from 'react';

export interface GpuImageItem {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
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
varying vec2 v_texCoord;
void main() { vec4 color = texture2D(u_image, v_texCoord); gl_FragColor = vec4(color.rgb, color.a * u_opacity); }
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
  const texturesRef = useRef(new Map<string, WebGLTexture>());
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
    const positionBuffer = gl.createBuffer();
    const textureBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, textureBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(textureLocation); gl.vertexAttribPointer(textureLocation, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    let cancelled = false;
    const draw = (item: GpuImageItem, texture: WebGLTexture) => {
      if (cancelled) return;
      const left = item.x / width * 2 - 1;
      const right = (item.x + item.width) / width * 2 - 1;
      const top = 1 - item.y / height * 2;
      const bottom = 1 - (item.y + item.height) / height * 2;
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([left, top, right, top, left, bottom, left, bottom, right, top, right, bottom]), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1f(opacityLocation, item.opacity); gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const redraw = () => {
      if (cancelled) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const item of items) {
        const texture = texturesRef.current.get(item.src);
        if (texture) draw(item, texture);
      }
    };
    for (const item of items) {
      const cached = texturesRef.current.get(item.src);
      if (cached) continue;
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        const texture = gl.createTexture();
        if (!texture) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        texturesRef.current.set(item.src, texture);
        // Images finish decoding out of order. Redraw the complete ordered list
        // so late textures can never cover a node that should be above them.
        redraw();
      };
      image.src = item.src;
    }
    redraw();
    return () => { cancelled = true; gl.deleteBuffer(positionBuffer); gl.deleteBuffer(textureBuffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); };
  }, [height, items, onSupportChange, width]);
  return <canvas ref={canvasRef} className="gpu-image-layer" width={Math.max(1, Math.round(width))} height={Math.max(1, Math.round(height))} aria-hidden="true" />;
});
