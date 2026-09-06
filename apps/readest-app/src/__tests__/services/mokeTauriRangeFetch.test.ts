import { describe, expect, it, vi } from 'vitest';

import { retryOnlineRead } from '@/services/mokeOnlineRetry';
import { createMokeTauriRangeFetch, type MokeTauriInvoke } from '@/services/mokeTauriRangeFetch';

const SOURCE = 'http://127.0.0.1:39209/read/resource/10.epub?revision=safe';

describe('Moke raw Tauri range transport', () => {
  it('keeps Range in the native plugin payload without constructing a browser Request', async () => {
    let reads = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return 1;
      if (command === 'plugin:http|fetch_send') {
        return {
          status: 206,
          statusText: 'Partial Content',
          url: SOURCE,
          headers: [
            ['content-type', 'application/epub+zip'],
            ['content-length', '1'],
            ['content-range', 'bytes 0-0/100'],
            ['etag', '"one"'],
          ],
          rid: 2,
        };
      }
      if (command === 'plugin:http|fetch_read_body') {
        reads += 1;
        return reads === 1 ? [0x50, 0] : [1];
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const fetch = createMokeTauriRangeFetch(invoke as unknown as MokeTauriInvoke);

    const response = await fetch(SOURCE, {
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
    });

    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x50]));
    expect(invoke).toHaveBeenNthCalledWith(1, 'plugin:http|fetch', {
      clientConfig: expect.objectContaining({
        method: 'GET',
        url: SOURCE,
        headers: [
          ['Range', 'bytes=0-0'],
          ['Accept-Encoding', 'identity'],
        ],
        maxRedirections: 0,
      }),
    });
  });

  it('cancels a response body that arrives after the caller aborts', async () => {
    let resolveSend: ((metadata: unknown) => void) | undefined;
    const send = new Promise((resolve) => {
      resolveSend = resolve;
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return 5;
      if (command === 'plugin:http|fetch_send') return send;
      if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') {
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const controller = new AbortController();
    const pending = createMokeTauriRangeFetch(invoke as unknown as MokeTauriInvoke)(SOURCE, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    resolveSend?.({
      status: 206,
      statusText: 'Partial Content',
      url: SOURCE,
      headers: [],
      rid: 6,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('plugin:http|fetch_cancel_body', { rid: 6 });
    });
  });

  it('cancels a rejected full response body without reading it', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return 3;
      if (command === 'plugin:http|fetch_send') {
        return {
          status: 200,
          statusText: 'OK',
          url: SOURCE,
          headers: [['content-length', '1000000']],
          rid: 4,
        };
      }
      if (command === 'plugin:http|fetch_cancel_body') return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const response = await createMokeTauriRangeFetch(invoke as unknown as MokeTauriInvoke)(SOURCE, {
      headers: { Range: 'bytes=0-0' },
    });

    await response.body?.cancel();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('plugin:http|fetch_cancel_body', { rid: 4 });
    });
    expect(invoke).not.toHaveBeenCalledWith('plugin:http|fetch_read_body', expect.anything());
  });
});

for (const blockedStage of ['create', 'headers', 'body-read']) {
  it(`reports ${blockedStage} on timeout without logging URLs`, async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const metadata = {
      status: 206,
      statusText: 'Partial Content',
      url: SOURCE,
      headers: [['content-length', '1']],
      rid: 21,
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'plugin:http|fetch') return blockedStage === 'create' ? gate : 20;
      if (command === 'plugin:http|fetch_send') return blockedStage === 'headers' ? gate : metadata;
      if (command === 'plugin:http|fetch_read_body') return gate;
      return undefined;
    });
    try {
      await expect(
        retryOnlineRead(
          async (signal) => {
            const response = await createMokeTauriRangeFetch(invoke as MokeTauriInvoke)(SOURCE, {
              headers: { Range: 'bytes=0-0' },
              signal,
            });
            return response.arrayBuffer();
          },
          () => false,
          new AbortController().signal,
          10,
        ),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      const logs = warnings.mock.calls.map(([line]) => String(line));
      const line = logs.find((line) => line.startsWith('[online-range] '));
      expect(JSON.parse(line!.slice(15))).toMatchObject({
        stage: blockedStage,
        reason: 'timeout',
        range: 'bytes=0-0',
        receivedBytes: 0,
        status: blockedStage === 'body-read' ? 206 : null,
      });
      expect(logs.join('')).not.toContain(SOURCE);
      expect(logs.join('')).not.toContain('revision=');
    } finally {
      release(blockedStage === 'create' ? 20 : blockedStage === 'headers' ? metadata : [1]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      warnings.mockRestore();
    }
  });
}

it('skips empty nonterminal native chunks before, between and after data', async () => {
  const chunks = [[0], [0x50, 0], [0], [0x4b, 0], [0], [1]];
  const invoke = async (command: string) => {
    if (command === 'plugin:http|fetch') return 30;
    if (command === 'plugin:http|fetch_send')
      return {
        status: 206,
        statusText: 'Partial Content',
        url: SOURCE,
        headers: [['content-length', '2']],
        rid: 31,
      };
    if (command === 'plugin:http|fetch_read_body') return chunks.shift();
    return undefined;
  };
  const body = await retryOnlineRead(
    async (signal) => {
      const response = await createMokeTauriRangeFetch(invoke as MokeTauriInvoke)(SOURCE, {
        headers: { Range: 'bytes=0-1' },
        signal,
      });
      return response.arrayBuffer();
    },
    () => false,
    new AbortController().signal,
    200,
  );
  expect(new Uint8Array(body)).toEqual(new Uint8Array([0x50, 0x4b]));
  expect(chunks).toHaveLength(0);
});
