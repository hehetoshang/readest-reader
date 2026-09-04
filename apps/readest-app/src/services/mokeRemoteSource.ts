import { isTauriAppPlatform } from '@/services/environment';
import type { RemoteFileTransport } from '@/utils/file';

const EPUB_MIME = 'application/epub+zip';
const SAFE_REVISION = /^[A-Za-z0-9._~-]{1,128}$/;
const SAFE_ETAG = /^[^\r\n]{1,256}$/;
const RANGE_HEADER = /^bytes=(\d+)-(\d+)$/;
const CONTENT_RANGE_HEADER = /^bytes (\d+)-(\d+)\/(\d+)$/;

export type MokeRemoteSourceErrorCode =
  | 'online.auth_required'
  | 'online.permission_denied'
  | 'online.not_found'
  | 'online.resource_changed'
  | 'online.range_unsupported'
  | 'online.mime_invalid'
  | 'online.response_invalid'
  | 'online.network';

export class MokeRemoteSourceError extends Error {
  constructor(
    readonly code: MokeRemoteSourceErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'MokeRemoteSourceError';
  }
}

export interface MokeRemoteSourceErrorDetail {
  code: MokeRemoteSourceErrorCode;
  operation: 'online.open';
  retryable: boolean;
  status?: number;
}

interface MokeRemoteSourceContext {
  url: string;
  mime: typeof EPUB_MIME;
}

export type MokeRemoteFetch = (url: string, init?: RequestInit) => Promise<Response>;

function normalizedMime(value: string | null): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || '';
}

function responseError(status: number): MokeRemoteSourceError {
  if (status === 401 || (status >= 300 && status < 400)) {
    return new MokeRemoteSourceError('online.auth_required', status);
  }
  if (status === 403) return new MokeRemoteSourceError('online.permission_denied', status);
  if (status === 404) return new MokeRemoteSourceError('online.not_found', status);
  if (status === 409 || status === 412) {
    return new MokeRemoteSourceError('online.resource_changed', status);
  }
  return new MokeRemoteSourceError('online.network', status);
}

function parseServerOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.origin !== value.replace(/\/$/, '')
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Validate the one remote resource shape Moke currently delegates to Reader.
 * Keeping this check in Reader prevents a forged launch URL from turning the
 * embedded file loader into a generic authenticated HTTP client.
 */
export function validateMokeRemoteSource(
  sourceUrl: string,
  serverUrl: string,
  bookId: string,
): MokeRemoteSourceContext {
  const origin = parseServerOrigin(serverUrl);
  if (!origin || !/^\d+$/.test(bookId)) {
    throw new MokeRemoteSourceError('online.response_invalid');
  }

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    throw new MokeRemoteSourceError('online.response_invalid');
  }

  const revisionValues = source.searchParams.getAll('revision');
  const queryKeys = [...source.searchParams.keys()];
  if (
    source.origin !== origin ||
    source.username ||
    source.password ||
    source.hash ||
    source.pathname !== `/read/resource/${bookId}.epub` ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'revision' ||
    revisionValues.length !== 1 ||
    !SAFE_REVISION.test(revisionValues[0] || '')
  ) {
    throw new MokeRemoteSourceError('online.response_invalid');
  }

  return { url: source.href, mime: EPUB_MIME };
}

export function mokeRemoteSourceErrorDetail(error: unknown): MokeRemoteSourceErrorDetail | null {
  if (!(error instanceof MokeRemoteSourceError)) return null;
  return {
    code: error.code,
    operation: 'online.open',
    retryable:
      error.status === undefined ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 412 ||
      error.status === 429 ||
      error.status >= 500,
    ...(error.status === undefined ? {} : { status: error.status }),
  };
}

async function defaultMokeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isTauriAppPlatform()) {
    return window.fetch(url, {
      ...init,
      credentials: 'include',
      redirect: 'error',
    });
  }

  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
  return tauriFetch(url, {
    ...init,
    credentials: 'include',
    maxRedirections: 0,
    danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
  } as unknown as RequestInit);
}

function abortResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function validateCommonResponse(response: Response, context: MokeRemoteSourceContext): void {
  if (!response.ok) throw responseError(response.status);
  if (response.redirected || response.url !== context.url) {
    throw new MokeRemoteSourceError('online.response_invalid', response.status);
  }
  if (normalizedMime(response.headers.get('content-type')) !== context.mime) {
    throw new MokeRemoteSourceError('online.mime_invalid', response.status);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new MokeRemoteSourceError('online.response_invalid', response.status);
  }
}

/** Build a credential-carrying but source-locked transport for RemoteFile. */
export function createMokeRemoteSourceTransport(
  sourceUrl: string,
  fetchImpl: MokeRemoteFetch = defaultMokeFetch,
): RemoteFileTransport | null {
  if (typeof window === 'undefined' || !window.__MOKE_EMBEDDED) return null;
  const serverUrl = window.__MOKE_SOURCE_SERVER_URL;
  const bookId = window.__MOKE_BOOK_ID;
  if (!serverUrl) return null;
  if (!bookId) throw new MokeRemoteSourceError('online.response_invalid');

  const context = validateMokeRemoteSource(sourceUrl, serverUrl, String(bookId));
  window.__MOKE_ONLINE_SOURCE_METRICS = {
    totalBytes: 0,
    transferredBytes: 0,
    rangeRequests: 0,
  };
  const activeControllers = new Set<AbortController>();
  let expectedSize: number | null = null;
  let expectedEtag: string | null = null;

  const releaseAfterBody = (response: Response, controller: AbortController, expectedLength: number) => {
    const readBody = response.arrayBuffer.bind(response);
    Object.defineProperty(response, 'arrayBuffer', {
      configurable: true,
      value: async () => {
        try {
          const body = await readBody();
          if (body.byteLength !== expectedLength) {
            throw new MokeRemoteSourceError('online.response_invalid', response.status);
          }
          const metrics = window.__MOKE_ONLINE_SOURCE_METRICS;
          if (metrics) {
            metrics.transferredBytes += body.byteLength;
            metrics.rangeRequests += 1;
          }
          return body;
        } finally {
          activeControllers.delete(controller);
        }
      },
    });
  };

  return {
    // Partial-MD5 probes touch several distant offsets. A small online cache
    // avoids turning those probes into an accidental whole-file transfer for
    // ordinary EPUBs while preserving larger ranges requested by the parser.
    maxCacheChunkSize: 16 * 1024,
    async fetch(url, init = {}) {
      if (url !== context.url) throw new MokeRemoteSourceError('online.response_invalid');
      const method = (init.method || 'GET').toUpperCase();
      const inputHeaders = new Headers(init.headers);
      const inputHeaderNames = [...inputHeaders.keys()].map((name) => name.toLowerCase());
      const rangeHeader = inputHeaders.get('range');
      if (
        (method !== 'HEAD' && method !== 'GET') ||
        inputHeaderNames.some((name) => name !== 'range') ||
        (method === 'HEAD' && rangeHeader) ||
        (method === 'GET' && !rangeHeader?.match(RANGE_HEADER))
      ) {
        throw new MokeRemoteSourceError('online.response_invalid');
      }
      const safeHeaders = new Headers();
      safeHeaders.set('Accept-Encoding', 'identity');
      if (rangeHeader) safeHeaders.set('Range', rangeHeader);

      const controller = new AbortController();
      activeControllers.add(controller);
      const externalSignal = init.signal;
      const forwardAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });

      let response: Response | undefined;
      try {
        response = await fetchImpl(url, {
          method,
          headers: safeHeaders,
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal,
        });
        validateCommonResponse(response, context);

        const etag = response.headers.get('etag');
        if (!etag || !SAFE_ETAG.test(etag)) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }

        if (method === 'HEAD') {
          if (response.status !== 200 || response.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') {
            throw new MokeRemoteSourceError('online.range_unsupported', response.status);
          }
          const size = Number(response.headers.get('content-length'));
          if (!Number.isSafeInteger(size) || size <= 0) {
            throw new MokeRemoteSourceError('online.response_invalid', response.status);
          }
          expectedSize = size;
          expectedEtag = etag;
          if (window.__MOKE_ONLINE_SOURCE_METRICS) {
            window.__MOKE_ONLINE_SOURCE_METRICS.totalBytes = size;
          }
          try {
            await response.arrayBuffer();
          } catch {
            // HEAD metadata is complete; body disposal is best effort.
          }
          activeControllers.delete(controller);
          return response;
        }

        const range = rangeHeader?.match(RANGE_HEADER);
        if (!range || response.status !== 206 || expectedSize === null || expectedEtag === null) {
          throw new MokeRemoteSourceError('online.range_unsupported', response.status);
        }
        if (etag !== expectedEtag) {
          throw new MokeRemoteSourceError('online.resource_changed', response.status);
        }

        const requestedStart = Number(range[1]);
        const requestedEnd = Number(range[2]);
        const contentRange = response.headers.get('content-range')?.match(CONTENT_RANGE_HEADER);
        if (
          !contentRange ||
          Number(contentRange[1]) !== requestedStart ||
          Number(contentRange[2]) !== requestedEnd ||
          Number(contentRange[3]) !== expectedSize
        ) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }
        const expectedLength = requestedEnd - requestedStart + 1;
        if (Number(response.headers.get('content-length')) !== expectedLength) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }
        releaseAfterBody(response, controller, expectedLength);
        return response;
      } catch (error) {
        activeControllers.delete(controller);
        if (response) abortResponse(response);
        if (error instanceof MokeRemoteSourceError) throw error;
        throw new MokeRemoteSourceError('online.network');
      } finally {
        externalSignal?.removeEventListener('abort', forwardAbort);
      }
    },
    close() {
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
    },
  };
}
