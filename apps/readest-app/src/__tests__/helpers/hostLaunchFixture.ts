import {
  MokeHostLaunch,
  validateReaderClaim,
  type ReaderClaim,
  type ReaderInvoke,
  type ReaderReservation,
} from '@/services/mokeHostLaunch';

export function claimFixture(base = 'http://books.example/a'): ReaderClaim {
  return validateReaderClaim(
    {
      schema: 'moke.readest.host-launch.v1',
      launchId: 'synthetic-launch',
      phase: 'claimed',
      completion: 'pending',
      claimToken: 'synthetic-claim-not-an-authorization',
      progressOwner: 'host',
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
  );
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

export function launchFixture(
  claim = claimFixture(),
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
