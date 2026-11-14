import { describe, expect, it } from 'vitest';
import { ContractError, decodeFrame, decodeHostInfo, meterHeight } from '../src/protocol';

import frameExample from '../../contract/frame.example.json';
import hostInfoExample from '../../contract/host-info.example.json';

/** A fresh copy of an example from the contract, safe to change. */
const contract = (name: 'frame.example.json' | 'host-info.example.json'): unknown =>
  structuredClone(name === 'frame.example.json' ? frameExample : hostInfoExample) as unknown;

describe('frame contract', () => {
  it('decodes the example frame the C++ self-test is checked against', () => {
    const frame = decodeFrame(contract('frame.example.json'));
    expect(frame.levelsDb).toEqual([-14.2, -18.7]);
    expect(frame.playing).toBe(true);
    expect(frame.loopEndSec).toBe(8);
  });

  it('decodes the example host info', () => {
    const info = decodeHostInfo(contract('host-info.example.json'));
    expect(info.audio.blockSize).toBe(441);
    expect(info.settle.timedOut).toBe(false);
  });

  it.each([
    ['a missing field', (f: Record<string, unknown>) => delete f['audibleSec']],
    ['a string where a number belongs', (f: Record<string, unknown>) => (f['seq'] = '1')],
    ['NaN, which JSON cannot carry but a bug could', (f: Record<string, unknown>) => (f['positionSec'] = Number.NaN)],
    ['three meter levels', (f: Record<string, unknown>) => (f['levelsDb'] = [0, 0, 0])],
    ['another contract version', (f: Record<string, unknown>) => (f['v'] = 2)],
  ])('rejects a frame with %s', (_, mutate) => {
    const f = contract('frame.example.json') as Record<string, unknown>;
    mutate(f);
    expect(() => decodeFrame(f)).toThrow(ContractError);
  });

  it('rejects host info without audio details', () => {
    const h = contract('host-info.example.json') as Record<string, unknown>;
    delete h['audio'];
    expect(() => decodeHostInfo(h)).toThrow(ContractError);
  });
});

describe('meterHeight', () => {
  it('maps -60 dB and below to empty and 0 dB and above to full', () => {
    expect(meterHeight(-100)).toBe(0);
    expect(meterHeight(-60)).toBe(0);
    expect(meterHeight(-30)).toBeCloseTo(0.5);
    expect(meterHeight(0)).toBe(1);
    expect(meterHeight(6)).toBe(1);
    expect(meterHeight(Number.NaN)).toBe(0);
  });
});
