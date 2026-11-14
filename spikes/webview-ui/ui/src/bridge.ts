// A small typed wrapper over the object JUCE injects into the page as
// `window.__JUCE__`. It speaks the same protocol as JUCE's own @juce-framework/webview
// package (native functions are an `__juce__invoke` event answered by `__juce__complete`),
// but takes the backend as a parameter so tests and a plain browser can supply a fake.

/** The part of `window.__JUCE__.backend` this page uses. */
export interface JuceBackend {
  addEventListener(eventId: string, fn: (payload: unknown) => void): unknown;
  emitEvent(eventId: string, payload: unknown): void;
}

export interface JuceGlobal {
  backend: JuceBackend;
  initialisationData: { __juce__functions?: string[] } & Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`Native function '${name}' did not answer within ${ms} ms`);
    this.name = 'BridgeTimeoutError';
  }
}

export class NativeBridge {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly backend: JuceBackend,
    private readonly functions: readonly string[] = [],
    private readonly timeoutMs = 5000,
  ) {
    backend.addEventListener('__juce__complete', (payload) => {
      const { promiseId, result } = (payload ?? {}) as { promiseId?: unknown; result?: unknown };
      if (typeof promiseId !== 'number') return;
      const entry = this.pending.get(promiseId);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      this.pending.delete(promiseId);
      entry.resolve(result);
    });
  }

  /** Whether the host registered a native function with this name. */
  has(name: string): boolean {
    return this.functions.includes(name);
  }

  /** Calls a native function registered with WebBrowserComponent::Options::withNativeFunction. */
  call(name: string, ...params: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeTimeoutError(name, this.timeoutMs));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.backend.emitEvent('__juce__invoke', { name, params, resultId: id });
    });
  }

  /** Listens for an event the host sends with WebBrowserComponent::emitEventIfBrowserIsVisible. */
  on(eventId: string, fn: (payload: unknown) => void): void {
    this.backend.addEventListener(eventId, fn);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/** The JUCE global, if this page is running inside the C++ host. */
export function findJuce(scope: { __JUCE__?: unknown }): JuceGlobal | undefined {
  const juce = scope.__JUCE__ as Partial<JuceGlobal> | undefined;
  if (juce === undefined || juce.backend === undefined || juce.initialisationData === undefined) return undefined;
  return juce as JuceGlobal;
}
