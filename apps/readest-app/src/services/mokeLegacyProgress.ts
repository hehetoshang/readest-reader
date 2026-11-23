import { invoke } from '@tauri-apps/api/core';
import { eventDispatcher } from '@/utils/event';
import { MokeHostLaunch, validateReaderClaim } from './mokeHostLaunch';
import { parseLibraryBaseUrl } from './mokeLibraryBase';

const SCHEMA = 'moke.readest.legacy-mobile-progress.v1';
const DEBOUNCE_MS = 1200;
const IPC_TIMEOUT_MS = 2000;

type Position = Record<string, unknown>;

interface Claim {
  schema: typeof SCHEMA;
  launchId: string;
  claimToken: string;
  documentGeneration: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function request(command: string, args: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('reader_legacy_progress_unconfirmed')),
      IPC_TIMEOUT_MS,
    );
  });
  // Invoke in the current task so pagehide can submit before the document leaves.
  try {
    return await Promise.race([deadline, invoke(command, args)]);
  } finally {
    clearTimeout(timer);
  }
}

class LegacyMobileProgress {
  private pending?: { position: Position; key: string };
  private timer?: ReturnType<typeof setTimeout>;
  private lastSubmittedKey?: string;
  private sequence = 0;
  private writes = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private returning?: Promise<void>;
  private destroyed = false;
  private failure?: Error;

  constructor(
    private readonly claim: Claim,
    private readonly resource: MokeHostLaunch,
  ) {}

  acceptsPosition(): boolean {
    return !this.closing && !this.destroyed;
  }

  stage(position: Position): void {
    if (!this.acceptsPosition() || this.failure) return;
    const { location, section_href, page, fraction } = position;
    if (!location && !section_href) return;
    const key = JSON.stringify(
      location ? [location, section_href] : [section_href, page, fraction],
    );
    if (key === this.pending?.key) return;
    clearTimeout(this.timer);
    this.pending = undefined;
    if (key === this.lastSubmittedKey) return;
    this.pending = { position, key };
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  flush = (): void => {
    clearTimeout(this.timer);
    const frame = this.pending;
    this.pending = undefined;
    if (!frame || this.destroyed || this.failure || !this.resource.isActive()) return;
    this.lastSubmittedKey = frame.key;
    const sequence = ++this.sequence;
    const write = this.save(sequence, frame.position).catch((error: Error) => {
      if (!this.destroyed && !this.failure) {
        this.failure = new Error(
          error?.message === 'reader_legacy_progress_write_failed'
            ? error.message
            : 'reader_legacy_progress_unconfirmed',
        );
      }
    });
    this.writes.add(write);
    void write.then(() => this.writes.delete(write));
  };

  private receipt(reply: unknown): Record<string, unknown> {
    const result = record(reply);
    if (
      this.destroyed ||
      result['schema'] !== SCHEMA ||
      result['launchId'] !== this.claim.launchId ||
      result['documentGeneration'] !== this.claim.documentGeneration
    ) {
      throw new Error('reader_legacy_progress_unconfirmed');
    }
    return result;
  }

  private async save(sequence: number, payload: Position): Promise<void> {
    for (let attempt = 0; !this.destroyed && !this.failure; attempt++) {
      const reply = this.receipt(
        await request('moke_reader_legacy_progress_capture', { ...this.claim, sequence, payload }),
      );
      const lastSequence = reply['lastSequence'];
      if (
        reply['sequence'] !== sequence ||
        typeof lastSequence !== 'number' ||
        !Number.isSafeInteger(lastSequence) ||
        lastSequence < 0 ||
        lastSequence > this.sequence
      ) {
        throw new Error('reader_legacy_progress_unconfirmed');
      }
      const status = reply['status'];
      if (
        ((status === 'saved' || status === 'duplicate') && lastSequence === sequence) ||
        (status === 'superseded' && lastSequence > sequence)
      ) {
        return;
      }
      if (status !== 'write-failed' || lastSequence >= sequence) {
        throw new Error('reader_legacy_progress_unconfirmed');
      }
      if (attempt >= 2) throw new Error('reader_legacy_progress_write_failed');
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  close(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('reader_legacy_progress_unconfirmed'));
    if (!this.closing) {
      this.flush();
      this.closing = this.confirmClose();
      void this.closing.catch(() => undefined);
    }
    return this.closing;
  }

  returnToLibrary(navigate: () => void | Promise<unknown>): Promise<void> {
    return (this.returning ??= this.close().then(async () => {
      if (this.destroyed) throw new Error('reader_legacy_progress_unconfirmed');
      await navigate();
    }));
  }

  private async confirmClose(): Promise<void> {
    const lastSequence = this.sequence;
    await Promise.all(this.writes);
    if (this.failure) throw this.failure;
    if (this.destroyed) throw new Error('reader_legacy_progress_unconfirmed');
    this.resource.assertActive();
    this.resource.stopResourceRequests();
    const result = this.receipt(
      await request('moke_reader_legacy_progress_close', { ...this.claim, lastSequence }),
    );
    if (result['status'] !== 'ready' || result['lastSequence'] !== lastSequence) {
      throw new Error('reader_legacy_progress_unconfirmed');
    }
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.pending = undefined;
  }
}

let progress: LegacyMobileProgress | undefined;
let legacyResource: MokeHostLaunch | undefined;
let bootstrap: Promise<void> | undefined;

export function getMokeLegacyProgress(): LegacyMobileProgress | undefined {
  return progress;
}

export function getMokeLegacyResource(): MokeHostLaunch | undefined {
  return legacyResource;
}

function eligibleLookup(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const ids = params.getAll('mokeLegacyProgressId');
  if (
    params.get('moke') !== '1' ||
    params.has('mokeLaunchId') ||
    params.get('mokeReturnTo') !== '/library' ||
    !['android', 'ohos', 'ios'].includes(params.get('mokeRuntimePlatform') ?? '') ||
    !params.get('mokeBookId') ||
    !params.get('mokeServerUrl') ||
    params.getAll('file').length !== 1 ||
    !/^https?:\/\//i.test(params.get('file') ?? '') ||
    ids.length !== 1 ||
    !ids[0] ||
    ids[0].length > 128
  ) {
    return;
  }
  return ids[0];
}

export function bootstrapMokeLegacyProgress(): Promise<void> {
  const launchId = eligibleLookup();
  if (!launchId) return Promise.resolve();
  return (bootstrap ??= claimProgress(launchId));
}

async function claimProgress(launchId: string): Promise<void> {
  let destroyed = false;
  const flush = () => {
    if (!progress) return;
    eventDispatcher.dispatchSync('flush-legacy-reader-relocate');
    progress.flush();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => {
    try {
      flush();
    } finally {
      destroyed = true;
      progress?.destroy();
      legacyResource?.stopResourceRequests();
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
  window.addEventListener('pagehide', onPageHide, { once: true });
  try {
    const result = record(
      await request('moke_reader_legacy_progress_claim', { schema: SCHEMA, launchId }),
    );
    if (
      destroyed ||
      result['schema'] !== SCHEMA ||
      result['launchId'] !== launchId ||
      (result['status'] !== 'claimed' && result['status'] !== 'local-only')
    )
      return;

    const online = validateReaderClaim(result['onlineClaim'], launchId);
    const params = new URLSearchParams(window.location.search);
    if (
      online.resource.kind === 'downloaded-epub' ||
      online.localProgress ||
      online.resource.url !== params.get('file') ||
      online.bookId !== params.get('mokeBookId') ||
      online.source.libraryBaseUrl !==
        parseLibraryBaseUrl(params.get('mokeServerUrl') ?? '').baseUrl
    )
      return;

    legacyResource = new MokeHostLaunch(online, invoke, async (event, handler) => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().listen(event, handler);
    });
    if (result['status'] === 'claimed') {
      const { claimToken, documentGeneration } = online;
      progress = new LegacyMobileProgress(
        { schema: SCHEMA, launchId, claimToken, documentGeneration },
        legacyResource,
      );
      document.addEventListener('visibilitychange', onVisibility);
    }
  } catch {
    // An older or unavailable host leaves the ordinary Reader-local path usable.
  } finally {
    if (!legacyResource) window.removeEventListener('pagehide', onPageHide);
  }
}
