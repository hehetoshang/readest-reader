import { isTauriAppPlatform } from '@/services/environment';
import { mokeTauriRangeFetch } from '@/services/mokeTauriRangeFetch';
import type { RemoteFileTransport } from '@/utils/file';

const EPUB_MIME = 'application/epub+zip';
const LEGACY_EPUB_MIME = 'application/octet-stream';
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
  responseMimes: readonly string[];
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
  const isBootstrapResource =
    source.pathname === `/read/resource/${bookId}.epub` &&
    queryKeys.length === 1 &&
    queryKeys[0] === 'revision' &&
    revisionValues.length === 1 &&
    SAFE_REVISION.test(revisionValues[0] || '');
  // Talebook Android opens this fixed authenticated file route directly.
  // Supporting the same route keeps pre-bootstrap Talebook 3.7+ compatible;
  // the transport still requires an exact 206 before Reader sees the source.
  const isLegacyResource =
    source.pathname === `/api/book/${bookId}.epub` &&
    queryKeys.length === 0;
  if (
    source.origin !== origin ||
    source.username ||
    source.password ||
    source.hash ||
    (!isBootstrapResource && !isLegacyResource)
  ) {
    throw new MokeRemoteSourceError('online.response_invalid');
  }

  return {
    url: source.href,
    mime: EPUB_MIME,
    responseMimes: isLegacyResource
      ? [EPUB_MIME, LEGACY_EPUB_MIME]
      : [EPUB_MIME],
  };
}

export function isMokeRemoteSourceUrl(sourceUrl: string): boolean {
  if (typeof window === 'undefined' || !window.__MOKE_EMBEDDED) return false;
  const serverUrl = window.__MOKE_SOURCE_SERVER_URL;
  const bookId = window.__MOKE_BOOK_ID;
  if (!serverUrl || !bookId) return false;
  try {
    validateMokeRemoteSource(sourceUrl, serverUrl, String(bookId));
    return true;
  } catch {
    return false;
  }
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

  return mokeTauriRangeFetch(url, init);
}

async function abortResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function validateResponseIdentity(response: Response, context: MokeRemoteSourceContext): void {
  if (response.redirected || response.url !== context.url) {
    throw new MokeRemoteSourceError('online.response_invalid', response.status);
  }
}

function validateRepresentation(response: Response, context: MokeRemoteSourceContext): void {
  validateResponseIdentity(response, context);
  if (!context.responseMimes.includes(normalizedMime(response.headers.get('content-type')))) {
    throw new MokeRemoteSourceError('online.mime_invalid', response.status);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new MokeRemoteSourceError('online.response_invalid', response.status);
  }
}

function rangeStatusError(response: Response): MokeRemoteSourceError {
  if (response.status === 200) {
    return new MokeRemoteSourceError('online.range_unsupported', response.status);
  }
  if (response.status === 416) {
    return new MokeRemoteSourceError('online.resource_changed', response.status);
  }
  if (!response.ok) return responseError(response.status);
  return new MokeRemoteSourceError('online.response_invalid', response.status);
}

function syntheticHeadResponse(
  context: MokeRemoteSourceContext,
  size: number,
  etag: string,
): Response {
  const response = new Response(null, {
    status: 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Content-Type': context.mime,
      ETag: etag,
    },
  });
  Object.defineProperty(response, 'url', { configurable: true, value: context.url });
  return response;
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
  const activeControllers = new Map<AbortController, () => void>();
  let expectedSize: number | null = null;
  let expectedEtag: string | null = null;

  const releaseAfterBody = (response: Response, expectedLength: number, cleanup: () => void) => {
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
          cleanup();
        }
      },
    });
  };

  return {
    // Moke's native transport supports HEAD on Android. Force that path so the
    // authoritative one-byte probe establishes size/ETag before parser ranges.
    openWithHead: true,
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

      const controller = new AbortController();
      const externalSignal = init.signal;
      const forwardAbort = () => controller.abort();
      const cleanupController = () => {
        activeControllers.delete(controller);
        externalSignal?.removeEventListener('abort', forwardAbort);
      };
      activeControllers.set(controller, cleanupController);
      externalSignal?.addEventListener('abort', forwardAbort, { once: true });
      if (externalSignal?.aborted) controller.abort();

      let response: Response | undefined;
      try {
        if (method === 'HEAD') {
          response = await fetchImpl(url, {
            method: 'HEAD',
            headers: safeHeaders,
            credentials: 'include',
            redirect: 'manual',
            signal: controller.signal,
          });
          validateResponseIdentity(response, context);

          let headSize: number | null = null;
          let headEtag: string | null = null;
          if (response.status === 200) {
            const mime = normalizedMime(response.headers.get('content-type'));
            const encoding = response.headers.get('content-encoding');
            const length = response.headers.get('content-length');
            const etag = response.headers.get('etag');
            if (mime && !context.responseMimes.includes(mime)) {
              throw new MokeRemoteSourceError('online.mime_invalid', response.status);
            }
            if (encoding && encoding.toLowerCase() !== 'identity') {
              throw new MokeRemoteSourceError('online.response_invalid', response.status);
            }
            if (length !== null) {
              headSize = Number(length);
              if (!Number.isSafeInteger(headSize) || headSize <= 0) {
                throw new MokeRemoteSourceError('online.response_invalid', response.status);
              }
            }
            if (etag !== null) {
              if (!SAFE_ETAG.test(etag)) {
                throw new MokeRemoteSourceError('online.response_invalid', response.status);
              }
              headEtag = etag;
            }
          } else if (response.status !== 405 && response.status !== 501) {
            throw response.ok
              ? new MokeRemoteSourceError('online.response_invalid', response.status)
              : responseError(response.status);
          }
          await abortResponse(response);

          // Verify the actual GET contract instead of trusting HEAD alone.
          // A valid one-byte 206 also provides authoritative metadata when an
          // otherwise compatible reverse proxy does not implement HEAD.
          safeHeaders.set('Range', 'bytes=0-0');
          response = await fetchImpl(url, {
            method: 'GET',
            headers: safeHeaders,
            credentials: 'include',
            redirect: 'manual',
            signal: controller.signal,
          });
          validateResponseIdentity(response, context);
          if (response.status !== 206) throw rangeStatusError(response);
          validateRepresentation(response, context);

          const contentRange = response.headers.get('content-range')?.match(CONTENT_RANGE_HEADER);
          const size = Number(contentRange?.[3]);
          const etag = response.headers.get('etag');
          if (
            !contentRange ||
            contentRange[1] !== '0' ||
            contentRange[2] !== '0' ||
            response.headers.get('content-length') !== '1' ||
            !Number.isSafeInteger(size) ||
            size <= 0 ||
            !etag ||
            !SAFE_ETAG.test(etag)
          ) {
            throw new MokeRemoteSourceError('online.response_invalid', response.status);
          }
          if (headSize !== null && headSize !== size) {
            throw new MokeRemoteSourceError('online.resource_changed', response.status);
          }
          if (headEtag !== null && headEtag !== etag) {
            throw new MokeRemoteSourceError('online.resource_changed', response.status);
          }

          const firstByte = await response.arrayBuffer();
          if (firstByte.byteLength !== 1) {
            throw new MokeRemoteSourceError('online.response_invalid', response.status);
          }
          expectedSize = size;
          expectedEtag = etag;
          const metrics = window.__MOKE_ONLINE_SOURCE_METRICS;
          if (metrics) {
            metrics.totalBytes = size;
            metrics.transferredBytes += 1;
            metrics.rangeRequests += 1;
          }
          cleanupController();
          return syntheticHeadResponse(context, size, etag);
        }

        const range = rangeHeader?.match(RANGE_HEADER);
        if (!range || expectedSize === null || expectedEtag === null) {
          throw new MokeRemoteSourceError('online.response_invalid');
        }
        const requestedStart = Number(range[1]);
        const requestedEnd = Number(range[2]);
        if (
          !Number.isSafeInteger(requestedStart) ||
          !Number.isSafeInteger(requestedEnd) ||
          requestedStart < 0 ||
          requestedStart > requestedEnd ||
          requestedStart >= expectedSize
        ) {
          throw new MokeRemoteSourceError('online.response_invalid');
        }
        // RemoteFile reads [start,end] but deliberately prefetches beyond the
        // requested slice. Clamp that cache window before sending it so the
        // wire request remains a valid, exact single range at EOF.
        const effectiveEnd = Math.min(requestedEnd, expectedSize - 1);
        safeHeaders.set('Range', `bytes=${requestedStart}-${effectiveEnd}`);
        response = await fetchImpl(url, {
          method: 'GET',
          headers: safeHeaders,
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal,
        });
        validateResponseIdentity(response, context);
        if (response.status !== 206) throw rangeStatusError(response);
        validateRepresentation(response, context);

        const etag = response.headers.get('etag');
        if (!etag || !SAFE_ETAG.test(etag)) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }
        if (etag !== expectedEtag) {
          throw new MokeRemoteSourceError('online.resource_changed', response.status);
        }

        const contentRange = response.headers.get('content-range')?.match(CONTENT_RANGE_HEADER);
        if (
          !contentRange ||
          Number(contentRange[1]) !== requestedStart ||
          Number(contentRange[2]) !== effectiveEnd ||
          Number(contentRange[3]) !== expectedSize
        ) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }
        const expectedLength = effectiveEnd - requestedStart + 1;
        if (Number(response.headers.get('content-length')) !== expectedLength) {
          throw new MokeRemoteSourceError('online.response_invalid', response.status);
        }
        releaseAfterBody(response, expectedLength, cleanupController);
        return response;
      } catch (error) {
        cleanupController();
        if (response) await abortResponse(response);
        if (error instanceof MokeRemoteSourceError) throw error;
        throw new MokeRemoteSourceError('online.network');
      }
    },
    close() {
      for (const [controller, cleanup] of [...activeControllers]) {
        controller.abort();
        cleanup();
      }
    },
  };
}
