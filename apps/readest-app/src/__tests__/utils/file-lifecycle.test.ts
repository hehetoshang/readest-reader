import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeFile, RemoteFile } from '@/utils/file';

const io = vi.hoisted(() => ({
  opens: 0, closes: 0,
  read: async (buffer: Uint8Array): Promise<number> => { buffer.fill(65); return buffer.length; },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: {}, SeekMode: { Start: 0 }, FileHandle: class {},
  open: async () => {
    io.opens++;
    return {
      stat: async () => ({ size: 4 * 1024 * 1024 }), seek: async () => 0,
      read: (buffer: Uint8Array) => io.read(buffer),
      close: async () => { io.closes++; },
    };
  },
}));
vi.mock('@/utils/misc', () => ({ getOSPlatform: () => 'windows' }));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
beforeEach(() => {
  io.opens = io.closes = 0;
  io.read = async buffer => { buffer.fill(65); return buffer.length; };
});

describe('file close fence', () => {
  it('concurrent native opens share one handle and close cannot reopen it', async () => {
    const file = new NativeFile('test.pdf');
    const opening = file.open();
    expect(file.open()).toBe(opening);
    await opening;
    expect(io.opens).toBe(1);
    await file.close();
    expect(io.closes).toBe(1);
    await expect(file.open()).rejects.toThrow('closed');
  });

  it('closing a queued native open prevents handle acquisition', async () => {
    const file = new NativeFile('test.pdf');
    const opening = expect(file.open()).rejects.toThrow('closed');
    const closing = file.close();
    await opening;
    await closing;
    expect(io.opens).toBe(0);
  });
  for (const size of [4, 2 * 1024 * 1024]) {
    it(`drains native reads (${size} bytes) and rejects late/cache reads`, async () => {
      const gate = deferred(), started = deferred();
      io.read = async buffer => { started.resolve(); await gate.promise; return buffer.length; };
      const file = await new NativeFile('test.pdf').open();
      const read = file.readData(4096, 4096 + size);
      const rejected = expect(read).rejects.toThrow('closed');
      await started.promise;
      const closing = file.close();
      expect(file.close()).toBe(closing);
      let complete = false;
      void closing.then(() => { complete = true; });
      await Promise.resolve();
      expect(complete).toBe(false);
      gate.resolve();
      await rejected;
      await closing;
      expect(io.opens).toBe(io.closes);
      await expect(file.readData(4096, 4100)).rejects.toThrow('closed');
      await expect(file.open()).rejects.toThrow('closed');
    });
  }

  it('closes native stream handles on read failure', async () => {
    io.read = async () => { throw new Error('disk failure'); };
    const file = await new NativeFile('test.epub').open();
    await expect(file.stream().getReader().read()).rejects.toThrow('disk failure');
    await file.close();
    expect(io.opens).toBe(io.closes);
  });

  it('stream cancellation drains its in-flight handle', async () => {
    const gate = deferred(), started = deferred();
    io.read = async buffer => { started.resolve(); await gate.promise; return buffer.length; };
    const file = await new NativeFile('test.epub').open();
    const reader = file.stream().getReader();
    const read = reader.read();
    await started.promise;
    const cancelling = reader.cancel();
    gate.resolve();
    await cancelling;
    await read;
    await file.close();
    expect(io.opens).toBe(io.closes);
  });

  it('native stream success releases every independent handle', async () => {
    const file = await new NativeFile('test.epub').open();
    const reader = file.stream().getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(file.size);
    await file.close();
    expect(io.opens).toBe(io.closes);
  });

  it('remote close aborts but waits for an abort-ignoring response body', async () => {
    const gate = deferred(), started = deferred();
    let signal: AbortSignal | null | undefined;
    const close = vi.fn();
    const file = await new RemoteFile('https://example.test/book.pdf', undefined, '', 0, {
      fetch: async (_url, init) => {
        if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '4194304' } });
        signal = init?.signal;
        const response = new Response(null, { status: 206 });
        response.arrayBuffer = async () => {
          started.resolve();
          await gate.promise;
          return new ArrayBuffer(128 * 1024);
        };
        return response;
      }, close,
    }).open();
    const read = file.fetchRange(4096, 4099);
    const rejected = expect(read).rejects.toThrow('closed');
    await started.promise;
    const closing = file.close();
    expect(file.close()).toBe(closing);
    expect(signal?.aborted).toBe(true);
    let complete = false;
    void closing.then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    gate.resolve();
    await rejected;
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    await expect(file.fetchRange(4096, 4099)).rejects.toThrow('closed');
  });

  it('opening response cannot revive a closed remote file', async () => {
    const gate = deferred(), started = deferred();
    const file = new RemoteFile('https://example.test/book.pdf', undefined, '', 0, {
      fetch: async () => {
        started.resolve(); await gate.promise;
        return new Response(null, { headers: { 'content-length': '42' } });
      },
    });
    const opening = expect(file.open()).rejects.toThrow('closed');
    await started.promise;
    const closing = file.close();
    gate.resolve();
    await opening;
    await closing;
    expect(file.size).toBe(-1);
  });
});
