import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMokeRemoteSourceTransport,
  MokeRemoteSourceError,
  mokeRemoteSourceErrorDetail,
  validateMokeRemoteSource,
} from '@/services/mokeRemoteSource';

const SERVER = 'https://books.example';
const SOURCE = `${SERVER}/read/resource/42.epub?revision=abc-123`;

function response(
  status: number,
  headers: Record<string, string>,
  body: BodyInit | null = null,
  url = SOURCE,
): Response {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, 'url', { configurable: true, value: url });
  Object.defineProperty(result, 'redirected', { configurable: true, value: false });
  return result;
}

beforeEach(() => {
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_SOURCE_SERVER_URL = SERVER;
  window.__MOKE_BOOK_ID = '42';
});

afterEach(() => {
  window.__MOKE_EMBEDDED = false;
  window.__MOKE_SOURCE_SERVER_URL = null;
  window.__MOKE_ONLINE_SOURCE_METRICS = null;
  window.__MOKE_BOOK_ID = null;
});

describe('Moke online source authorization', () => {
  it('accepts only the current book resource with one revision', () => {
    expect(validateMokeRemoteSource(SOURCE, SERVER, '42')).toEqual({
      url: SOURCE,
      mime: 'application/epub+zip',
    });

    for (const invalid of [
      'https://evil.example/read/resource/42.epub?revision=abc-123',
      `${SERVER}/read/resource/41.epub?revision=abc-123`,
      `${SERVER}/read/resource/42.epub`,
      `${SERVER}/read/resource/42.epub?revision=a&revision=b`,
      `${SERVER}/read/resource/42.epub?revision=a&url=https://evil.example`,
      `${SERVER}/api/book/42.epub?revision=abc-123`,
      `https://user:secret@books.example/read/resource/42.epub?revision=abc-123`,
    ]) {
      expect(() => validateMokeRemoteSource(invalid, SERVER, '42')).toThrow(
        MokeRemoteSourceError,
      );
    }
  });

  it('requires HEAD metadata and exact 206 reads without buffering a full response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          'content-type': 'application/epub+zip',
          'content-length': '1000',
          'accept-ranges': 'bytes',
          etag: '"revision-one"',
        }),
      )
      .mockResolvedValueOnce(
        response(
          206,
          {
            'content-type': 'application/epub+zip',
            'content-length': '4',
            'content-range': 'bytes 4-7/1000',
            etag: '"revision-one"',
          },
          new Uint8Array([4, 5, 6, 7]),
        ),
      );
    const transport = createMokeRemoteSourceTransport(SOURCE, fetchMock)!;

    await expect(transport.fetch(SOURCE, { method: 'HEAD' })).resolves.toBeDefined();
    const ranged = await transport.fetch(SOURCE, { headers: { Range: 'bytes=4-7' } });
    await expect(ranged.arrayBuffer()).resolves.toHaveProperty('byteLength', 4);
    expect(window.__MOKE_ONLINE_SOURCE_METRICS).toEqual({
      totalBytes: 1000,
      transferredBytes: 4,
      rangeRequests: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a server that ignores Range before reading its full body', async () => {
    const fullBodyRead = vi.fn(async () => new ArrayBuffer(10_000));
    const fullResponse = response(
      200,
      {
        'content-type': 'application/epub+zip',
        'content-length': '10000',
        'accept-ranges': 'bytes',
        etag: '"revision-one"',
      },
      new Uint8Array(10_000),
    );
    Object.defineProperty(fullResponse, 'arrayBuffer', { value: fullBodyRead });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          'content-type': 'application/epub+zip',
          'content-length': '10000',
          'accept-ranges': 'bytes',
          etag: '"revision-one"',
        }),
      )
      .mockResolvedValueOnce(fullResponse);
    const transport = createMokeRemoteSourceTransport(SOURCE, fetchMock)!;

    await transport.fetch(SOURCE, { method: 'HEAD' });
    await expect(
      transport.fetch(SOURCE, { headers: { Range: 'bytes=0-3' } }),
    ).rejects.toMatchObject({ code: 'online.range_unsupported' });
    expect(fullBodyRead).not.toHaveBeenCalled();
  });

  it('rejects redirects, MIME changes and ETag changes with stable metadata', async () => {
    const redirected = response(
      200,
      {
        'content-type': 'application/epub+zip',
        'content-length': '1000',
        'accept-ranges': 'bytes',
        etag: '"one"',
      },
      null,
      'https://evil.example/read/resource/42.epub?revision=abc-123',
    );
    const redirectedTransport = createMokeRemoteSourceTransport(
      SOURCE,
      vi.fn().mockResolvedValue(redirected),
    )!;
    await expect(redirectedTransport.fetch(SOURCE, { method: 'HEAD' })).rejects.toMatchObject({
      code: 'online.response_invalid',
    });

    const changedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          'content-type': 'application/epub+zip',
          'content-length': '1000',
          'accept-ranges': 'bytes',
          etag: '"one"',
        }),
      )
      .mockResolvedValueOnce(
        response(206, {
          'content-type': 'application/epub+zip',
          'content-length': '4',
          'content-range': 'bytes 0-3/1000',
          etag: '"two"',
        }),
      );
    const changedTransport = createMokeRemoteSourceTransport(SOURCE, changedFetch)!;
    await changedTransport.fetch(SOURCE, { method: 'HEAD' });
    await expect(
      changedTransport.fetch(SOURCE, { headers: { Range: 'bytes=0-3' } }),
    ).rejects.toMatchObject({ code: 'online.resource_changed' });

    const mimeTransport = createMokeRemoteSourceTransport(
      SOURCE,
      vi.fn().mockResolvedValue(
        response(200, {
          'content-type': 'text/html',
          'content-length': '1000',
          'accept-ranges': 'bytes',
          etag: '"one"',
        }),
      ),
    )!;
    await expect(mimeTransport.fetch(SOURCE, { method: 'HEAD' })).rejects.toMatchObject({
      code: 'online.mime_invalid',
    });
  });

  it('aborts active requests when the remote file closes', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
    );
    const transport = createMokeRemoteSourceTransport(SOURCE, fetchMock)!;
    const pending = transport.fetch(SOURCE, { method: 'HEAD' });
    await Promise.resolve();
    transport.close?.();
    await expect(pending).rejects.toMatchObject({ code: 'online.network' });
  });

  it('maps only normalized error metadata to the host event', () => {
    expect(
      mokeRemoteSourceErrorDetail(
        new MokeRemoteSourceError('online.resource_changed', 409),
      ),
    ).toEqual({
      code: 'online.resource_changed',
      operation: 'online.open',
      retryable: true,
      status: 409,
    });
    expect(mokeRemoteSourceErrorDetail(new Error(SOURCE))).toBeNull();
  });
});
