import {
  MokeHostLaunch,
  validateReaderClaim,
  type OnlineEpubResource,
  type ReaderClaim,
  type ReaderInvoke,
  type ReaderReservation,
} from '@/services/mokeHostLaunch';

export function claimFixture(
  base = 'http://books.example/a',
  localProgress?: ReaderClaim['localProgress'],
): ReaderClaim & { resource: OnlineEpubResource } {
  return validateReaderClaim(
    {
      schema: 'moke.readest.host-launch.v1',
      launchId: 'synthetic-launch',
      phase: 'claimed',
      completion: 'pending',
      claimToken: 'synthetic-claim-not-an-authorization',
      progressOwner: 'host',
      localProgress,
      source: { savedServerId: 'fixture', entryRevision: 'fixture-1', libraryBaseUrl: base },
      bookId: '42',
      ownerDocumentGeneration: 17,
      documentGeneration: 1,
      epoch: 2,
      lastSequence: 0,
      resource: {
        url: `${base}/read/resource/42.epub?revision=one`,
        effectiveBaseUrl: base,
        revision: 'one',
        size: 1000,
        etag: '"one"',
      },
    },
    'synthetic-launch',
  ) as ReaderClaim & { resource: OnlineEpubResource };
}

export function localProgressFixture(
  changes: Partial<NonNullable<ReaderClaim['localProgress']>> = {},
): NonNullable<ReaderClaim['localProgress']> {
  return {
    schema: 'moke.readest.host-local-progress.v1',
    accountId: '7',
    fileVersion: 'epub-bytes-1',
    format: 'epub',
    returnTarget: 'desktop-window',
    restore: {
      id: 'restore-1',
      position: {
        schema: 'moke.readest.progress.v1',
        reader: 'readest',
        moke_book_id: '42',
        location: 'epubcfi(/6/4!/4/2)',
      },
    },
    ...changes,
  };
}

export function reservation(
  claim: ReaderClaim,
  changes: Partial<ReaderReservation> = {},
): ReaderReservation {
  const {
    schema: _schema,
    claimToken: _token,
    resource: _resource,
    progressOwner: _owner,
    ...record
  } = claim;
  return { ...record, ...changes };
}

export function downloadedClaimFixture(
  localProgress = localProgressFixture(),
  size = 1000,
): ReaderClaim {
  const claim = claimFixture();
  return validateReaderClaim(
    {
      ...claim,
      localProgress,
      resource: { kind: 'downloaded-epub', size, fileVersion: localProgress.fileVersion },
    },
    claim.launchId,
  );
}

export function launchFixture(
  claim: ReaderClaim = claimFixture(),
  invoke: ReaderInvoke = async <T>() => undefined as T,
) {
  let handler: ((event: { payload: unknown }) => void) | undefined;
  let listening = false;
  const launch = new MokeHostLaunch(claim, invoke, async (_name, callback) => {
    handler = callback;
    listening = true;
    return () => {
      listening = false;
    };
  });
  return { launch, hint: (payload: unknown) => handler?.({ payload }), listening: () => listening };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
