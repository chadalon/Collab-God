// What this web view offers for GPU drawing. Run once at start-up and saved in the
// report, so the Windows and macOS web views can be compared line by line.

export interface WebGLInfo {
  available: boolean;
  version?: string;
  shadingLanguage?: string;
  vendor?: string;
  renderer?: string;
  maxTextureSize?: number;
  maxSamples?: number;
  extensions?: number;
}

export interface Capabilities {
  userAgent: string;
  devicePixelRatio: number;
  hardwareConcurrency: number;
  webgl2: WebGLInfo;
  webgl1: WebGLInfo;
  webgpu: {
    /** `navigator.gpu` exists. */
    api: boolean;
    /** requestAdapter() returned an adapter. */
    adapter: boolean;
    adapterInfo?: Record<string, string>;
    features?: string[];
    error?: string;
  };
  offscreenCanvas: boolean;
  offscreenWebGL2InWorker: 'not tested';
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
}

function webglInfo(kind: 'webgl2' | 'webgl'): WebGLInfo {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext(kind) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (gl === null) return { available: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const info: WebGLInfo = {
      available: true,
      version: String(gl.getParameter(gl.VERSION)),
      shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      extensions: gl.getSupportedExtensions()?.length ?? 0,
    };
    if (kind === 'webgl2') info.maxSamples = Number(gl.getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch {
    return { available: false };
  }
}

interface GpuAdapterLike {
  info?: Record<string, unknown>;
  features?: Iterable<string>;
}

interface GpuLike {
  requestAdapter(options?: { powerPreference?: string }): Promise<GpuAdapterLike | null>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms))]);

export async function detectCapabilities(): Promise<Capabilities> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  const webgpu: Capabilities['webgpu'] = { api: gpu !== undefined, adapter: false };

  if (gpu !== undefined) {
    try {
      const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: 'high-performance' }), 3000);
      webgpu.adapter = adapter !== null;
      if (adapter?.info !== undefined) {
        const info: Record<string, string> = {};
        for (const key of ['vendor', 'architecture', 'device', 'description']) {
          const v = adapter.info[key];
          if (typeof v === 'string' && v !== '') info[key] = v;
        }
        webgpu.adapterInfo = info;
      }
      if (adapter?.features !== undefined) webgpu.features = [...adapter.features].sort();
    } catch (e) {
      webgpu.error = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgl2: webglInfo('webgl2'),
    webgl1: webglInfo('webgl'),
    webgpu,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    offscreenWebGL2InWorker: 'not tested',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}

/** One line per capability, for the on-screen readout. */
export function describeCapabilities(c: Capabilities): string {
  const gl = c.webgl2.available ? `WebGL2 yes (${c.webgl2.renderer ?? '?'})` : 'WebGL2 NO';
  const gpu = !c.webgpu.api ? 'WebGPU no API' : c.webgpu.adapter ? 'WebGPU yes' : `WebGPU API but no adapter${c.webgpu.error ? ` (${c.webgpu.error})` : ''}`;
  return `${gl}\n${gpu}; DPR ${c.devicePixelRatio}`;
}
