import { describe, expect, it, vi } from 'vitest';
import {
  MokeHostLaunch,
  validateReaderClaim,
  type ReaderInvoke,
  type ReaderReservation,
} from '@/services/mokeHostLaunch';
import { claimFixture, deferred, launchFixture, reservation } from '../helpers/hostLaunchFixture';
import {
  presentationConfig,
  progressPayload,
  readManagedProgress,
  writeManagedProgress,
} from '@/services/mokeProgressIdentity';

describe('native Reader claim and complete original identity', () => {
  it.each([
    'http://books.example',
    'http://books.example/a',
    'http://books.example/b',
  ])('accepts exact root/prefix %s', (base) => {
    const claim = claimFixture(base);
    expect(claim.source.libraryBaseUrl).toBe(base);
    expect(Object.isFrozen(claim.source)).toBe(true);
  });
  it('keeps original HTTP identity during a permitted resource HTTPS upgrade', () => {
    const original = claimFixture();
    const claim = validateReaderClaim(
      {
        ...original,
        resource: {
          ...original.resource,
          url: 'https://books.example/a/read/resource/42.epub?revision=one',
          effectiveBaseUrl: 'https://books.example/a',
        },
      },
      original.launchId,
    );
    expect(launchFixture(claim).launch.identity).toBe('["http://books.example/a","42"]');
  });
  it('accepts the fixed legacy EPUB template from a native claim', () => {
    const original = claimFixture();
    expect(
      validateReaderClaim(
        {
          ...original,
          resource: {
            ...original.resource,
            url: 'http://books.example/a/api/book/42.epub',
            revision: null,
          },
        },
        original.launchId,
      ).resource.revision,
    ).toBeNull();
  });
  it('rejects HTTPS changes on a non-default resource port', () => {
    const c = claimFixture('http://books.example:8080/a');
    expect(() =>
      validateReaderClaim(
        {
          ...c,
          resource: {
            ...c.resource,
            effectiveBaseUrl: 'https://books.example:8080/a',
            url: 'https://books.example:8080/a/read/resource/42.epub?revision=one',
          },
        },
        c.launchId,
      ),
    ).toThrow();
  });
  it.each([
    { schema: 'unknown' },
    { progressOwner: 'reader' },
    { documentGeneration: 0 },
    { claimToken: '' },
    { phase: 'revoked' },
    { completion: 'unknown' },
    { lastSequence: 2 },
    {
      source: {
        savedServerId: 'x',
        entryRevision: '1',
        libraryBaseUrl: 'http://books.example/a/../b',
      },
    },
  ])('rejects missing/wrong contract fields: %j', (change) => {
    expect(() =>
      validateReaderClaim({ ...claimFixture(), ...change }, 'synthetic-launch'),
    ).toThrow();
  });
  it.each([
    'http://books.example/b/read/resource/42.epub?revision=one',
    'http://books.example/a/read/resource/43.epub?revision=one',
    'http://books.example/a/read/resource/42.epub?revision=one&url=evil',
    'http://books.example/a/read/resource/42.epub?revision=two',
  ])('rejects unsealed resource %s', (url) => {
    const c = claimFixture();
    expect(() =>
      validateReaderClaim({ ...c, resource: { ...c.resource, url } }, c.launchId),
    ).toThrow();
  });
  it('separates equal book bytes at same-origin /a and /b, and never reads/deletes anonymous originals', () => {
    const a = launchFixture().launch;
    const b = launchFixture(claimFixture('http://books.example/b')).launch;
    const items = new Map<string, string>([
      ['moke:reading-progress::42', '{"location":"anonymous"}'],
    ]);
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
    writeManagedProgress(a, progressPayload({ book_id: 'same-bytes', location: 'A' }, a), storage);
    writeManagedProgress(b, progressPayload({ book_id: 'same-bytes', location: 'B' }, b), storage);
    expect(readManagedProgress(a, storage)?.['location']).toBe('A');
    expect(readManagedProgress(b, storage)?.['location']).toBe('B');
    expect(items.get('moke:reading-progress::42')).toBe('{"location":"anonymous"}');
    expect([...items.values()].join('')).not.toContain('synthetic-claim');
  });
  it('reuses presentation settings without borrowing anonymous position fields', () => {
    expect(
      presentationConfig({
        updatedAt: 22,
        location: 'anonymous',
        xpointer: 'other',
        progress: [8, 10],
        viewSettings: { defaultFontSize: 20 },
      }),
    ).toEqual({ updatedAt: 0, viewSettings: { defaultFontSize: 20 }, searchConfig: undefined });
  });
});

describe('host progress relay and drain', () => {
  it('sends increasing sequences once and captures the payload before queue awaits', async () => {
    const claim = claimFixture();
    const first = deferred<ReaderReservation>();
    const invoke = vi.fn(async (_command, args) =>
      args?.['sequence'] === 1 ? first.promise : reservation(claim, { lastSequence: 2 }),
    );
    const { launch } = launchFixture(claim, invoke as ReaderInvoke);
    const data = { location: 'first' };
    const p1 = launch.progress(data);
    const p2 = launch.progress({ location: 'second' });
    data.location = 'changed';
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0]?.[1]?.['payload']).toEqual({ location: 'first' });
    first.resolve(reservation(claim, { lastSequence: 1 }));
    await Promise.all([p1, p2]);
    expect(invoke.mock.calls.map(([, args]) => args?.['sequence'])).toEqual([1, 2]);
  });
  it('waits for local writes, subscribes before closing, and requires the authoritative same-sequence result', async () => {
    const claim = claimFixture();
    let closings = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'moke_reader_progress')
        return reservation(claim, { lastSequence: Number(args?.['sequence']) });
      closings++;
      return reservation(claim, {
        lastSequence: 1,
        phase: closings === 1 ? 'closing' : 'returned',
        completion: closings === 1 ? 'pending' : 'complete',
      });
    });
    const f = launchFixture(claim, invoke as ReaderInvoke);
    await f.launch.progress({ location: 'final' });
    const local = deferred<void>();
    f.launch.trackWrite(local.promise);
    let returned = false;
    const closing = f.launch.close().then(() => {
      returned = true;
    });
    await vi.waitFor(() => expect(f.listening()).toBe(true));
    expect(closings).toBe(0);
    local.resolve();
    await vi.waitFor(() => expect(closings).toBe(1));
    f.hint({ launchId: claim.launchId, lastSequence: 0 });
    await Promise.resolve();
    expect(closings).toBe(1);
    expect(returned).toBe(false);
    f.hint({ launchId: claim.launchId, lastSequence: 1 });
    await closing;
    expect(returned).toBe(true);
    expect(f.listening()).toBe(false);
    expect(
      invoke.mock.calls
        .filter(([c]) => c === 'moke_reader_closing')
        .map(([, a]) => a?.['lastSequence']),
    ).toEqual([1, 1]);
    expect(invoke.mock.calls.filter(([c]) => c === 'moke_reader_progress')).toHaveLength(1);
    expect(() => f.launch.progress({ location: 'late' })).toThrow();
  });
  it('handles a drain-ready hint arriving before the first closing IPC reply', async () => {
    const claim = claimFixture();
    const first = deferred<ReaderReservation>();
    let calls = 0;
    const f = launchFixture(claim, (async () =>
      ++calls === 1
        ? first.promise
        : reservation(claim, { phase: 'returned', completion: 'failed' })) as ReaderInvoke);
    const closing = f.launch.close();
    await vi.waitFor(() => expect(calls).toBe(1));
    f.hint({ launchId: claim.launchId, lastSequence: 0 });
    first.resolve(reservation(claim, { phase: 'closing' }));
    await closing;
    expect(calls).toBe(2);
  });
  it('keeps unknown IPC outcomes occupied without progress replay or successful navigation', async () => {
    const invoke = vi.fn(async () => {
      throw Error('lost reply');
    });
    const { launch } = launchFixture(claimFixture(), invoke as ReaderInvoke);
    await expect(launch.progress({ location: 'x' })).rejects.toThrow();
    await expect(launch.close()).rejects.toThrow();
    expect(() => launch.progress({ location: 'replay' })).toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });
  it('does not confuse host and Reader document generations', async () => {
    const claim = claimFixture();
    const f = launchFixture(claim, (async () =>
      reservation(claim, {
        ownerDocumentGeneration: 1,
        documentGeneration: 17,
        lastSequence: 1,
      })) as ReaderInvoke);
    await expect(f.launch.progress({})).rejects.toThrow();
    expect(f.launch.isActive()).toBe(false);
  });
  it('keeps a failed local write unknown instead of acknowledging a return', async () => {
    const invoke = vi.fn();
    const f = launchFixture(claimFixture(), invoke);
    const local = deferred<void>();
    f.launch.trackWrite(local.promise);
    const closing = f.launch.close();
    local.reject(new Error('storage unavailable'));
    await expect(closing).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(f.launch.isActive()).toBe(false);
  });
  it('rejects altered resource URLs or methods before native dispatch', () => {
    const invoke = vi.fn();
    const launch = new MokeHostLaunch(claimFixture(), invoke, async () => () => {});
    expect(() =>
      launch.resourceLifecycle('http://books.example/b/api/book/42.epub', 'GET'),
    ).toThrow();
    expect(() => launch.resourceLifecycle(launch.claim.resource.url, 'POST')).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
