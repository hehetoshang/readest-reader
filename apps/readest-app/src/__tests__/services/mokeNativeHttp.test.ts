import { describe, expect, it, vi } from 'vitest';
import { nativeHttpRequest } from '@/services/mokeNativeHttp';
import type { ReaderInvoke } from '@/services/mokeHostLaunch';
import { claimFixture, deferred, launchFixture } from '../helpers/hostLaunchFixture';

describe('managed native resource terminal proof and original-ticket ACK', () => {
  it('dispatches before HTTP and withholds final bytes until native EOF and original settle ACK', async () => {
    const c = claimFixture();
    const ack = deferred<void>();
    const commands: string[] = [];
    const invoke = vi.fn(async (command: string) => {
      commands.push(command);
      if (command === 'moke_reader_resource_dispatch')
        return { requestId: 'original-ticket', epoch: c.epoch };
      if (command === 'plugin:http|fetch') return 1;
      if (command === 'plugin:http|fetch_send')
        return { status: 206, statusText: 'Partial', url: c.resource.url, headers: [], rid: 2 };
      if (command === 'plugin:http|fetch_read_body') return [80, 75, 1];
      if (command === 'moke_reader_resource_settle') return ack.promise;
      throw Error(command);
    });
    const { launch } = launchFixture(c, invoke as ReaderInvoke);
    const response = await nativeHttpRequest(
      c.resource.url,
      { headers: { Range: 'bytes=0-1' } },
      launch.resourceLifecycle(c.resource.url, 'GET'),
      invoke as ReaderInvoke,
    );
    let done = false;
    const body = response.arrayBuffer().then((b) => {
      done = true;
      return b;
    });
    await vi.waitFor(() => expect(commands).toContain('moke_reader_resource_settle'));
    expect(done).toBe(false);
    expect(commands.slice(0, 2)).toEqual(['moke_reader_resource_dispatch', 'plugin:http|fetch']);
    expect(invoke).toHaveBeenCalledWith(
      'moke_reader_resource_settle',
      expect.objectContaining({ requestId: 'original-ticket' }),
    );
    ack.resolve();
    expect([...new Uint8Array(await body)]).toEqual([80, 75]);
  });
  it('waits for both pending native read and cancellation ACK before settle', async () => {
    const read = deferred<number[]>();
    const cancel = deferred<void>();
    const controller = new AbortController();
    const lifecycle = {
      dispatch: vi.fn(async () => {}),
      settle: vi.fn(async () => {}),
      uncertain: vi.fn(),
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return 1;
      if (command === 'plugin:http|fetch_send')
        return {
          status: 206,
          statusText: '',
          url: 'http://books.example/a/api/book/42.epub',
          headers: [],
          rid: 2,
        };
      if (command === 'plugin:http|fetch_read_body') return read.promise;
      if (command === 'plugin:http|fetch_cancel_body') return cancel.promise;
      throw Error(command);
    });
    const response = await nativeHttpRequest(
      'http://books.example/a/api/book/42.epub',
      { signal: controller.signal },
      lifecycle,
      invoke as ReaderInvoke,
    );
    const reading = response.arrayBuffer();
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('plugin:http|fetch_read_body', { rid: 2 }),
    );
    controller.abort();
    cancel.resolve();
    await Promise.resolve();
    expect(lifecycle.settle).not.toHaveBeenCalled();
    read.resolve([0]);
    await rejected;
    expect(lifecycle.settle).toHaveBeenCalledOnce();
    expect(lifecycle.uncertain).not.toHaveBeenCalled();
  });
  it('a lost settle ACK marks unknown and never retries the original settle mutation', async () => {
    const lifecycle = {
      dispatch: vi.fn(async () => {}),
      settle: vi.fn(async () => {
        throw Error('lost ACK');
      }),
      uncertain: vi.fn(),
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return 1;
      if (command === 'plugin:http|fetch_send')
        return {
          status: 206,
          statusText: '',
          url: 'http://books.example/a/api/book/42.epub',
          headers: [],
          rid: 2,
        };
      if (command === 'plugin:http|fetch_read_body') return [1];
      throw Error(command);
    });
    const response = await nativeHttpRequest(
      'http://books.example/a/api/book/42.epub',
      {},
      lifecycle,
      invoke as ReaderInvoke,
    );
    await expect(response.arrayBuffer()).rejects.toThrow('lost ACK');
    expect(lifecycle.settle).toHaveBeenCalledOnce();
    expect(lifecycle.uncertain).toHaveBeenCalledOnce();
  });
  it('unconfirmed cancellation becomes unknown without settling or releasing a ticket', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = {
        dispatch: vi.fn(async () => {}),
        settle: vi.fn(async () => {}),
        uncertain: vi.fn(),
      };
      const invoke = vi.fn(async (command: string) => {
        if (command === 'plugin:http|fetch') return 1;
        if (command === 'plugin:http|fetch_send') return new Promise(() => {});
        if (command === 'plugin:http|fetch_cancel') return undefined;
        throw Error(command);
      });
      const request = nativeHttpRequest(
        'http://books.example/a/api/book/42.epub',
        {},
        lifecycle,
        invoke as ReaderInvoke,
        { deadlineMs: 10, cancellationGraceMs: 5 },
      );
      const rejected = expect(request).rejects.toMatchObject({
        nativeCode: 'http_completion_unknown',
      });
      await vi.advanceTimersByTimeAsync(16);
      await rejected;
      expect(lifecycle.settle).not.toHaveBeenCalled();
      expect(lifecycle.uncertain).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
