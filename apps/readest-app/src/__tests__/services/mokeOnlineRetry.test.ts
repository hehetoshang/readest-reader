import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryOnlineRead } from '@/services/mokeOnlineRetry';

afterEach(() => vi.useRealTimers());

describe('bounded online read recovery', () => {
  it('backs off twice and stops after three failed attempts', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
      throw new TypeError('network');
    });
    const pending = retryOnlineRead(read, () => true, new AbortController().signal);
    const checked = expect(pending).rejects.toThrow('network');
    await vi.runAllTimersAsync();
    await checked;
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('times out hung operations and aborts each native request', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    });
    const pending = retryOnlineRead(read, () => true, new AbortController().signal);
    const checked = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.runAllTimersAsync();
    await checked;
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('does not retry after close during backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn(async () => {
      throw new TypeError('network');
    });
    const pending = retryOnlineRead(read, () => true, controller.signal);
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.runAllTimersAsync();
    await checked;
    expect(read).toHaveBeenCalledOnce();
  });
});
