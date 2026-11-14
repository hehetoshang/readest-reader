import { parseLibraryBaseUrl } from './mokeLibraryBase';

export type ReaderInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ReaderListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;
export type Completion = 'pending' | 'complete' | 'failed' | 'unknown';
export interface ReaderReservation {
  launchId: string;
  phase: 'reserved' | 'sealed' | 'opening' | 'claimed' | 'closing' | 'returned' | 'revoked';
  completion: Completion;
  source: { savedServerId: string; entryRevision: string; libraryBaseUrl: string };
  bookId: string;
  ownerDocumentGeneration: number;
  documentGeneration: number;
  epoch: number;
  lastSequence: number;
}
export interface ReaderClaim extends ReaderReservation {
  schema: 'moke.readest.host-launch.v1';
  claimToken: string;
  progressOwner: 'host';
  resource: {
    url: string;
    effectiveBaseUrl: string;
    revision: string | null;
    size: number;
    etag: string;
  };
}

const invalid = () => new Error('reader_invalid_launch');
const uncertain = () => new Error('reader_launch_unknown');
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** Syntax mirrors the frozen host parser; authority still comes only from claim IPC. */
export function validateReaderClaim(value: unknown, launchId: string): ReaderClaim {
  if (
    !record(value) ||
    value['schema'] !== 'moke.readest.host-launch.v1' ||
    value['launchId'] !== launchId ||
    value['phase'] !== 'claimed' ||
    value['completion'] !== 'pending' ||
    value['progressOwner'] !== 'host' ||
    typeof value['claimToken'] !== 'string' ||
    !value['claimToken'] ||
    typeof value['bookId'] !== 'string' ||
    !/^\d{1,20}$/.test(value['bookId']) ||
    !positive(value['documentGeneration']) ||
    !positive(value['ownerDocumentGeneration']) ||
    !positive(value['epoch']) ||
    value['lastSequence'] !== 0
  )
    throw invalid();
  const source = value['source'];
  const resource = value['resource'];
  if (
    !record(source) ||
    !record(resource) ||
    typeof source['savedServerId'] !== 'string' ||
    !source['savedServerId'] ||
    typeof source['entryRevision'] !== 'string' ||
    !source['entryRevision'] ||
    typeof source['libraryBaseUrl'] !== 'string' ||
    typeof resource['effectiveBaseUrl'] !== 'string' ||
    typeof resource['url'] !== 'string' ||
    !positive(resource['size']) ||
    typeof resource['etag'] !== 'string' ||
    !/^[^\r\n]{1,256}$/.test(resource['etag'])
  )
    throw invalid();
  const original = parseLibraryBaseUrl(source['libraryBaseUrl']);
  const effective = parseLibraryBaseUrl(resource['effectiveBaseUrl']);
  if (
    original.baseUrl !== source['libraryBaseUrl'] ||
    effective.baseUrl !== resource['effectiveBaseUrl'] ||
    original.pathPrefix !== effective.pathPrefix ||
    !(
      original.origin === effective.origin ||
      (original.protocol === 'http' &&
        effective.protocol === 'https' &&
        original.host === effective.host &&
        original.port === '80' &&
        effective.port === '443')
    )
  )
    throw invalid();
  const revision = resource['revision'];
  const expected =
    revision === null
      ? `${effective.baseUrl}/api/book/${value['bookId']}.epub`
      : typeof revision === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(revision)
        ? `${effective.baseUrl}/read/resource/${value['bookId']}.epub?revision=${revision}`
        : null;
  if (resource['url'] !== expected) throw invalid();
  // Clone/freeze all authority fields. Callers cannot rewrite a claim after validation.
  return Object.freeze({
    ...value,
    source: Object.freeze({ ...source }),
    resource: Object.freeze({ ...resource }),
  }) as unknown as ReaderClaim;
}

/** One instance per claimed document. No mutation is retried after an unknown IPC result. */
export class MokeHostLaunch {
  readonly identity: string;
  private sequence = 0;
  private state: 'active' | 'draining' | 'returned' | 'unknown' = 'active';
  private queue: Promise<void> = Promise.resolve();
  private tickets = new Set<string>();
  private cancelRequests = new Set<() => void>();
  private closingPromise?: Promise<void>;
  private observePromise?: Promise<void>;
  private finishClose?: () => void;
  private failClose?: (error: unknown) => void;
  private unlisten?: () => void;
  private hinted = false;
  private canObserve = false;
  private writes = new Set<Promise<unknown>>();

  constructor(
    readonly claim: ReaderClaim,
    private invoke: ReaderInvoke,
    private listen: ReaderListen,
  ) {
    this.identity = JSON.stringify([claim.source.libraryBaseUrl, claim.bookId]);
  }

  assertActive(): void {
    if (this.state !== 'active') throw uncertain();
  }
  isActive(): boolean {
    return this.state === 'active';
  }
  private args(): Record<string, unknown> {
    return { launchId: this.claim.launchId, claimToken: this.claim.claimToken };
  }
  markUnknown = (): void => {
    this.state = 'unknown';
    this.failClose?.(uncertain());
    this.unlisten?.();
    this.unlisten = undefined;
  };
  trackWrite<T>(promise: Promise<T>): Promise<T> {
    this.writes.add(promise);
    void promise.then(
      () => this.writes.delete(promise),
      () => {
        this.writes.delete(promise);
        this.markUnknown();
      },
    );
    return promise;
  }
  private assertReservation(result: ReaderReservation, expectedSequence: number): void {
    const c = this.claim;
    if (
      result.launchId !== c.launchId ||
      result.documentGeneration !== c.documentGeneration ||
      result.ownerDocumentGeneration !== c.ownerDocumentGeneration ||
      result.epoch !== c.epoch ||
      result.bookId !== c.bookId ||
      result.lastSequence !== expectedSequence ||
      result.source?.libraryBaseUrl !== c.source.libraryBaseUrl ||
      result.source.savedServerId !== c.source.savedServerId ||
      result.source.entryRevision !== c.source.entryRevision
    )
      throw uncertain();
  }
  progress(payload: Record<string, unknown>): Promise<void> {
    this.assertActive();
    // Capture payload now, before any asynchronous work or a later relocate can change it.
    const captured = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const sequence = ++this.sequence;
    const operation = this.queue.then(async () => {
      if (this.state === 'unknown' || this.state === 'returned') throw uncertain();
      const result = await this.invoke<ReaderReservation>('moke_reader_progress', {
        ...this.args(),
        sequence,
        payload: captured,
      });
      this.assertReservation(result, sequence);
      if (result.phase !== 'claimed' || result.completion !== 'pending') throw uncertain();
    });
    this.queue = operation.catch((error: unknown) => {
      this.markUnknown();
      throw error;
    });
    // Rejections remain visible to callers without creating an unhandled queue rejection.
    void this.queue.catch(() => undefined);
    return this.queue;
  }
  resourceLifecycle(url: string, method: string) {
    this.assertActive();
    if (url !== this.claim.resource.url || !['GET', 'HEAD'].includes(method)) throw invalid();
    let requestId: string | undefined;
    return {
      dispatch: async () => {
        this.assertActive();
        const result = await this.invoke<{ requestId: string; epoch: number }>(
          'moke_reader_resource_dispatch',
          {
            ...this.args(),
            url,
            method,
          },
        );
        if (
          typeof result.requestId !== 'string' ||
          !result.requestId ||
          result.epoch !== this.claim.epoch
        ) {
          this.markUnknown();
          throw uncertain();
        }
        requestId = result.requestId;
        this.tickets.add(requestId);
      },
      assertCurrent: () => this.assertActive(),
      registerCancellation: (cancel: () => void) => {
        this.cancelRequests.add(cancel);
        if (this.state !== 'active') cancel();
        return () => this.cancelRequests.delete(cancel);
      },
      settle: async () => {
        if (!requestId) throw uncertain();
        // A transport terminal state is supplied by mokeNativeHttp; only the ACK drops this ticket.
        await this.invoke('moke_reader_resource_settle', { ...this.args(), requestId });
        this.tickets.delete(requestId);
      },
      uncertain: this.markUnknown,
    };
  }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    if (this.state !== 'active') return Promise.reject(uncertain());
    this.state = 'draining';
    this.closingPromise = this.drain();
    return this.closingPromise;
  }
  private async drain(): Promise<void> {
    try {
      // Subscribe before closing: an ACK can emit the hint before closing's reply arrives.
      this.unlisten = await this.listen('moke:reader-drain-ready', ({ payload }) => {
        if (
          !record(payload) ||
          payload['launchId'] !== this.claim.launchId ||
          payload['lastSequence'] !== this.sequence ||
          this.state !== 'draining'
        )
          return;
        this.hinted = true;
        if (this.canObserve) void this.observeClosing();
      });
      const terminal = new Promise<void>((resolve, reject) => {
        this.finishClose = resolve;
        this.failClose = reject;
      });
      void terminal.catch(() => undefined);
      // Local writes and accepted progress are drained before freezing the final sequence at the host.
      await this.queue;
      await Promise.all([...this.writes]);
      if (this.state === 'unknown') throw uncertain();
      for (const cancel of this.cancelRequests) cancel();
      this.canObserve = true;
      await this.observeClosing();
      return await terminal;
    } catch (error) {
      this.markUnknown();
      throw error;
    }
  }
  private observeClosing(): Promise<void> {
    if (this.observePromise) return this.observePromise;
    this.hinted = false;
    this.observePromise = (async () => {
      try {
        const result = await this.invoke<ReaderReservation>('moke_reader_closing', {
          ...this.args(),
          lastSequence: this.sequence,
        });
        this.assertReservation(result, this.sequence);
        if (this.state !== 'draining') throw uncertain();
        if (result.phase === 'returned' && ['complete', 'failed'].includes(result.completion)) {
          if (this.tickets.size) throw uncertain();
          this.state = 'returned';
          this.unlisten?.();
          this.unlisten = undefined;
          this.finishClose?.();
        } else if (result.phase !== 'closing' || result.completion !== 'pending') throw uncertain();
      } catch {
        this.markUnknown();
      }
    })().finally(() => {
      this.observePromise = undefined;
      if (this.hinted && this.state === 'draining') void this.observeClosing();
    });
    return this.observePromise;
  }
}

let currentLaunch: MokeHostLaunch | null = null;
let bootstrap: Promise<MokeHostLaunch> | undefined;
export function getMokeHostLaunch(): MokeHostLaunch | null {
  return currentLaunch;
}
export function hasMokeHostLookup(): boolean {
  return (
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mokeLaunchId')
  );
}
export function bootstrapMokeHostLaunch(): Promise<MokeHostLaunch> {
  if (bootstrap) return bootstrap;
  bootstrap = (async () => {
    const params = new URLSearchParams(window.location.search);
    const ids = params.getAll('mokeLaunchId');
    if (
      params.get('moke') !== '1' ||
      ids.length !== 1 ||
      !ids[0] ||
      params.has('file') ||
      params.has('ids') ||
      params.has('cfi') ||
      params.has('mokeBookId') ||
      params.has('mokeServerUrl') ||
      params.has('mokeSourceServerUrl') ||
      params.has('mokeRestoreProgress')
    )
      throw invalid();
    const { invoke } = await import('@tauri-apps/api/core');
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    const claim = validateReaderClaim(
      await invoke('moke_reader_claim', { launchId: ids[0] }),
      ids[0],
    );
    currentLaunch = new MokeHostLaunch(claim, invoke, (event, handler) =>
      getCurrentWebview().listen(event, handler),
    );
    window.__MOKE_EMBEDDED = true;
    window.__MOKE_BOOK_ID = claim.bookId;
    window.__MOKE_SOURCE_SERVER_URL = null;
    window.__MOKE_SERVER_URL = null;
    window.__MOKE_RESTORE_PROGRESS = null;
    window.OPEN_WITH_FILES = [claim.resource.url];
    // Unavoidable document destruction invalidates this JS generation; it never acknowledges return.
    window.addEventListener('pagehide', () => currentLaunch?.markUnknown(), { once: true });
    return currentLaunch;
  })();
  return bootstrap;
}
