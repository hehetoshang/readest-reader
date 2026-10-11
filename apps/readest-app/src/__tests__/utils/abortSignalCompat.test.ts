import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAbortSignalCompat } from '@/utils/abortSignalCompat';

const targets = [
  [AbortController.prototype, 'abort'],
  [AbortSignal.prototype, 'reason'],
  [AbortSignal.prototype, 'throwIfAborted'],
  [AbortSignal, 'abort'],
  [AbortSignal, 'timeout'],
  [AbortSignal, 'any'],
] as const;
const descriptors = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
const nativeAbort = AbortController.prototype.abort;

function restore() {
  targets.forEach(([target, key], index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

beforeEach(() => {
  // Chrome 96 ignores abort(reason) and has none of these later additions.
  Object.defineProperty(AbortController.prototype, 'abort', {
    configurable: true,
    writable: true,
    value(this: AbortController) {
      nativeAbort.call(this);
    },
  });
  for (const [target, key] of targets.slice(1)) Reflect.deleteProperty(target, key);
  vi.useFakeTimers();
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Chrome 96 native cancellation compatibility', () => {
  it('preserves the first reason during the one native abort event', () => {
    const before = new AbortController();
    expect(before.signal.throwIfAborted).toBeUndefined();
    installAbortSignalCompat();
    const controller = new AbortController();
    const reason = new Error('cancel translation');
    const handler = vi.fn(() => expect(controller.signal.reason).toBe(reason));
    controller.signal.addEventListener('abort', handler);
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    controller.abort(reason);
    controller.abort('second reason');
    expect(controller.signal.aborted).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => controller.signal.throwIfAborted()).toThrow(reason);
  });

  it('handles preexisting signals, default errors and explicit null reasons', () => {
    const controller = new AbortController();
    controller.abort();
    installAbortSignalCompat();
    expect(controller.signal.reason.name).toBe('AbortError');
    expect(controller.signal.reason).toBe(controller.signal.reason);
    expect(AbortSignal.abort(null).reason).toBeNull();
    expect(AbortSignal.abort().reason.name).toBe('AbortError');
  });

  it('combines a caller cancellation with a request timeout and detaches every listener', () => {
    installAbortSignalCompat();
    const caller = new AbortController();
    const timeout = AbortSignal.timeout(15_000);
    const removeCaller = vi.spyOn(caller.signal, 'removeEventListener');
    const removeTimeout = vi.spyOn(timeout, 'removeEventListener');
    const signal = AbortSignal.any([caller.signal, timeout, caller.signal]);
    const handler = vi.fn();
    signal.addEventListener('abort', handler);
    caller.abort('cancel translation');
    expect(signal.reason).toBe('cancel translation');
    expect(removeCaller).toHaveBeenCalledTimes(1);
    expect(removeTimeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(signal.reason).toBe('cancel translation');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not attach listeners when an input is already aborted or invalid', () => {
    installAbortSignalCompat();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, 'addEventListener');
    expect(AbortSignal.any([caller.signal, AbortSignal.abort('already cancelled')]).reason).toBe(
      'already cancelled',
    );
    expect(add).not.toHaveBeenCalled();
    expect(() => AbortSignal.any([caller.signal, {} as AbortSignal])).toThrow(TypeError);
    expect(() => AbortSignal.any(null as unknown as AbortSignal[])).toThrow(TypeError);
    expect(add).not.toHaveBeenCalled();
    expect(AbortSignal.any([]).aborted).toBe(false);
  });

  it('times out asynchronously and does not overflow a long timeout', () => {
    installAbortSignalCompat();
    const short = AbortSignal.timeout(0);
    const long = AbortSignal.timeout(2 ** 31 + 10);
    expect(short.aborted).toBe(false);
    vi.advanceTimersByTime(0);
    expect(short.reason.name).toBe('TimeoutError');
    expect(long.aborted).toBe(false);
    vi.advanceTimersByTime(2 ** 31 + 10);
    expect(long.reason.name).toBe('TimeoutError');
    expect(vi.getTimerCount()).toBe(0);
    for (const delay of [-1, NaN, Infinity, 2 ** 64]) {
      expect(() => AbortSignal.timeout(delay)).toThrow(TypeError);
    }
  });

  it('leaves modern native methods intact', () => {
    restore();
    const before = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
    installAbortSignalCompat();
    expect(targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key))).toEqual(
      before,
    );
  });
});
