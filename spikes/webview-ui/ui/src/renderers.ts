// Two ways to draw the same scene. WebGL2 is the one being tested: every clip is an
// instance in one GPU buffer, so pan and zoom change four uniforms and nothing else.
// Canvas 2D is the comparison, and the fallback where WebGL2 is missing.

import { type Camera, rulerHeight } from './camera';
import { floatsPerRect } from './clips';
import type { RectList } from './scene';

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export interface Renderer {
  readonly name: 'webgl2' | 'canvas2d';
  setClips(data: Float32Array, count: number): void;
  /** Uploads the clip buffer again, as if every clip had been edited. */
  reuploadClips(): void;
  draw(camera: Camera, background: RectList, foreground: RectList, view: Viewport): void;
  dispose(): void;
}

const vertexShader = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_colour;
uniform vec2 u_view;
uniform vec4 u_camera; // origin seconds, seconds per px, scroll y, track height
uniform float u_world;
uniform float u_ruler;
out vec2 v_local;
out vec2 v_size;
out vec4 v_colour;
void main() {
  vec4 r = a_rect;
  if (u_world > 0.5) {
    float x = (r.x - u_camera.x) / u_camera.y;
    float w = max(r.z / u_camera.y, 1.0);
    float y = u_ruler + r.y * u_camera.w - u_camera.z + 1.0;
    float h = max(r.w * u_camera.w - 2.0, 1.0);
    r = vec4(x, y, w, h);
  }
  vec2 p = r.xy + a_corner * r.zw;
  v_local = a_corner * r.zw;
  v_size = r.zw;
  v_colour = a_colour;
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
}`;

// highp, the same as the vertex shader's default: WebKit refuses to link a program whose
// shared uniforms (u_world) have different precisions in the two stages.
const fragmentShader = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_size;
in vec4 v_colour;
uniform float u_world;
uniform float u_dpr;
out vec4 o;
void main() {
  vec4 c = v_colour;
  if (u_world > 0.5) {
    float radius = min(3.0, 0.5 * min(v_size.x, v_size.y));
    vec2 q = abs(v_local - v_size * 0.5) - (v_size * 0.5 - radius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    float coverage = clamp(0.5 - d * u_dpr, 0.0, 1.0);
    float inner = clamp(0.5 - (d + 1.0) * u_dpr, 0.0, 1.0);
    vec3 col = mix(c.rgb, c.rgb * 0.5, inner);
    if (v_local.y < 4.0) col = mix(col, c.rgb, 0.8);
    c = vec4(col, c.a * coverage);
  }
  o = vec4(c.rgb * c.a, c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader did not compile: ${gl.getShaderInfoLog(shader) ?? 'no log'}`);
  }
  return shader;
}

interface Batch {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  capacityBytes: number;
}

export class WebGL2Renderer implements Renderer {
  readonly name = 'webgl2';
  private readonly program: WebGLProgram;
  private readonly corners: WebGLBuffer;
  private readonly clips: Batch;
  private readonly background: Batch;
  private readonly foreground: Batch;
  private clipData: Float32Array = new Float32Array(0);
  private clipCount = 0;
  private readonly uniforms: Record<'view' | 'camera' | 'world' | 'ruler' | 'dpr', WebGLUniformLocation | null>;

  static create(canvas: HTMLCanvasElement): WebGL2Renderer | undefined {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    return gl === null ? undefined : new WebGL2Renderer(gl);
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexShader));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentShader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program did not link: ${gl.getProgramInfoLog(program) ?? 'no log'}`);
    }
    this.program = program;
    this.uniforms = {
      view: gl.getUniformLocation(program, 'u_view'),
      camera: gl.getUniformLocation(program, 'u_camera'),
      world: gl.getUniformLocation(program, 'u_world'),
      ruler: gl.getUniformLocation(program, 'u_ruler'),
      dpr: gl.getUniformLocation(program, 'u_dpr'),
    };

    this.corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

    this.clips = this.makeBatch();
    this.background = this.makeBatch();
    this.foreground = this.makeBatch();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private makeBatch(): Batch {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const stride = floatsPerRect * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
    return { vao, buffer, capacityBytes: 0 };
  }

  private upload(batch: Batch, data: Float32Array, count: number, usage: number): void {
    const gl = this.gl;
    const bytes = count * floatsPerRect * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
    if (bytes > batch.capacityBytes) {
      batch.capacityBytes = Math.max(bytes, batch.capacityBytes * 2, 4096);
      gl.bufferData(gl.ARRAY_BUFFER, batch.capacityBytes, usage);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * floatsPerRect);
  }

  setClips(data: Float32Array, count: number): void {
    this.clipData = data;
    this.clipCount = count;
    this.upload(this.clips, data, count, this.gl.STATIC_DRAW);
  }

  reuploadClips(): void {
    this.upload(this.clips, this.clipData, this.clipCount, this.gl.STATIC_DRAW);
  }

  draw(camera: Camera, background: RectList, foreground: RectList, view: Viewport): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = Math.round(view.width * view.dpr);
    const h = Math.round(view.height * view.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.043, 0.051, 0.071, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.view, view.width, view.height);
    gl.uniform4f(this.uniforms.camera, camera.originSec, camera.secPerPx, camera.scrollY, camera.trackHeight);
    gl.uniform1f(this.uniforms.ruler, rulerHeight);
    gl.uniform1f(this.uniforms.dpr, view.dpr);

    this.upload(this.background, background.data, background.count, gl.STREAM_DRAW);
    this.upload(this.foreground, foreground.data, foreground.count, gl.STREAM_DRAW);

    gl.uniform1f(this.uniforms.world, 0);
    this.drawBatch(this.background, background.count);
    gl.uniform1f(this.uniforms.world, 1);
    this.drawBatch(this.clips, this.clipCount);
    gl.uniform1f(this.uniforms.world, 0);
    this.drawBatch(this.foreground, foreground.count);
  }

  private drawBatch(batch: Batch, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    gl.bindVertexArray(batch.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const css = (d: Float32Array, o: number) =>
  `rgba(${Math.round((d[o] ?? 0) * 255)},${Math.round((d[o + 1] ?? 0) * 255)},${Math.round((d[o + 2] ?? 0) * 255)},${d[o + 3] ?? 1})`;

export class Canvas2DRenderer implements Renderer {
  readonly name = 'canvas2d';
  private clipData: Float32Array = new Float32Array(0);
  private clipCount = 0;

  static create(canvas: HTMLCanvasElement): Canvas2DRenderer | undefined {
    const ctx = canvas.getContext('2d', { alpha: false });
    return ctx === null ? undefined : new Canvas2DRenderer(ctx);
  }

  private constructor(private readonly ctx: CanvasRenderingContext2D) {}

  setClips(data: Float32Array, count: number): void {
    this.clipData = data;
    this.clipCount = count;
  }

  reuploadClips(): void {}

  draw(camera: Camera, background: RectList, foreground: RectList, view: Viewport): void {
    const ctx = this.ctx;
    const canvas = ctx.canvas;
    const w = Math.round(view.width * view.dpr);
    const h = Math.round(view.height * view.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, view.width, view.height);
    this.fillRects(background);

    const d = this.clipData;
    const left = camera.originSec;
    const right = camera.originSec + view.width * camera.secPerPx;
    for (let i = 0; i < this.clipCount; i++) {
      const o = i * floatsPerRect;
      const start = d[o] ?? 0;
      const length = d[o + 2] ?? 0;
      if (start > right || start + length < left) continue;
      const y = rulerHeight + (d[o + 1] ?? 0) * camera.trackHeight - camera.scrollY + 1;
      if (y > view.height || y + camera.trackHeight < 0) continue;
      const x = (start - left) / camera.secPerPx;
      const width = Math.max(1, length / camera.secPerPx);
      const height = Math.max(1, camera.trackHeight - 2);
      ctx.fillStyle = css(d, o + 4);
      ctx.fillRect(x, y, width, height);
    }

    this.fillRects(foreground);
  }

  private fillRects(list: RectList): void {
    const d = list.data;
    for (let i = 0; i < list.count; i++) {
      const o = i * floatsPerRect;
      this.ctx.fillStyle = css(d, o + 4);
      this.ctx.fillRect(d[o] ?? 0, d[o + 1] ?? 0, d[o + 2] ?? 0, d[o + 3] ?? 0);
    }
  }

  dispose(): void {}
}
