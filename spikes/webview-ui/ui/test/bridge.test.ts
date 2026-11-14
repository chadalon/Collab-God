import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeTimeoutError, findJuce, type JuceBackend, NativeBridge } from '../src/bridge';
import { decodeFrame } from '../src/protocol';
import { SimulatedHost } from '../src/simulated';

afterEach(() => vi.useRealTimers());

describe('NativeBridge', () => {
  it('sends JUCE invoke events and resolves with the matching completion', async () => {
    const host = new SimulatedHost({ autoFrames: false });
    const bridge = new NativeBridge(host, host.functions);
    const [a, b] = await Promise.all([bridge.call('ping', 'first'), bridge.call('ping', 'second')]);
    expect([a, b]).toEqual(['first', 'second']);
    expect(bridge.pendingCount).toBe(0);
  });

  it('matches answers that come back out of order', async () => {
    const listeners: ((p: unknown) => void)[] = [];
    const sent: { resultId: number; params: unknown[] }[] = [];
    const backend: JuceBackend = {
      addEventListener: (_id, fn) => listeners.push(fn),
      emitEvent: (_id, payload) => sent.push(payload as { resultId: number; params: unknown[] }),
    };
    const bridge = new NativeBridge(backend);
    const first = bridge.call('ping', 1);
    const second = bridge.call('ping', 2);
    for (const s of [...sent].reverse()) listeners.forEach((fn) => fn({ promiseId: s.resultId, result: s.params[0] }));
    expect(await first).toBe(1);
    expect(await second).toBe(2);
  });

  it('times out when the host never answers', async () => {
    vi.useFakeTimers();
    const backend: JuceBackend = { addEventListener: () => undefined, emitEvent: () => undefined };
    const bridge = new NativeBridge(backend, [], 100);
    const call = bridge.call('ping', 1);
    vi.advanceTimersByTime(101);
    await expect(call).rejects.toBeInstanceOf(BridgeTimeoutError);
    expect(bridge.pendingCount).toBe(0);
  });

  it('ignores completions it did not ask for', async () => {
    const listeners: ((p: unknown) => void)[] = [];
    const backend: JuceBackend = { addEventListener: (_id, fn) => listeners.push(fn), emitEvent: () => undefined };
    new NativeBridge(backend);
    expect(() => listeners.forEach((fn) => fn({ promiseId: 99, result: 1 }))).not.toThrow();
    expect(() => listeners.forEach((fn) => fn(undefined))).not.toThrow();
  });

  it('delivers frames that pass the contract', () => {
    const host = new SimulatedHost({ autoFrames: false });
    const bridge = new NativeBridge(host, host.functions);
    const frames: unknown[] = [];
    bridge.on('frame', (f) => frames.push(f));
    host.emitFrame();
    host.emitFrame();
    expect(frames).toHaveLength(2);
    expect(decodeFrame(frames[1]).seq).toBe(1);
  });
});

describe('SimulatedHost', () => {
  it('jumps to a seek target and keeps playing from there', async () => {
    let now = 0;
    const host = new SimulatedHost({ autoFrames: false, now: () => now });
    const bridge = new NativeBridge(host, host.functions);
    await bridge.call('seek', 6);
    now += 500;
    expect(host.buildFrame().audibleSec).toBeCloseTo(6.5);
    now += 2000; // past the loop end at 8 s, wraps to the start
    expect(host.buildFrame().audibleSec).toBeCloseTo(0.5);
  });

  it('adds as many extra meters as configured', async () => {
    const host = new SimulatedHost({ autoFrames: false });
    const bridge = new NativeBridge(host, host.functions);
    expect(await bridge.call('configure', { push: true, extraMeters: 3 })).toEqual({ push: true, extraMeters: 3 });
    expect(host.buildFrame().extraLevelsDb).toHaveLength(3);
  });
});

describe('findJuce', () => {
  it('finds the JUCE global only when the host injected it', () => {
    expect(findJuce({})).toBeUndefined();
    expect(findJuce({ __JUCE__: { backend: {} } })).toBeUndefined();
    const juce = { backend: { addEventListener: () => 0, emitEvent: () => undefined }, initialisationData: {} };
    expect(findJuce({ __JUCE__: juce })).toBe(juce);
  });
});
