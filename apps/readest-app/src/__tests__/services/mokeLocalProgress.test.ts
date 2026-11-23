import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimFixture,
  deferred,
  launchFixture,
  localProgressFixture,
  reservation,
} from '@/__tests__/helpers/hostLaunchFixture';
import { validateReaderClaim } from '@/services/mokeHostLaunch';
import {
  progressPayload,
  readManagedProgress,
  writeManagedProgress,
} from '@/services/mokeProgressIdentity';

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('claimed host local progress v1', () => {
  it('keeps an old claim readable and rejects a mismatched format or book restore', () => {
    expect(claimFixture().localProgress).toBeUndefined();
    const fixture = localProgressFixture();
    expect(() =>
      claimFixture(undefined, { ...fixture, format: 'pdf' } as unknown as typeof fixture),
    ).toThrow();
    const position = { ...fixture.restore!.position, moke_book_id: '99' };
    expect(() =>
      claimFixture(undefined, localProgressFixture({ restore: { id: 'other', position } })),
    ).toThrow();
  });

  it('accepts a book-start instruction only with an explicit null restore', () => {
    const claim = claimFixture();
    const local = localProgressFixture({ restore: null });
    const validate = (localProgress: unknown) =>
      validateReaderClaim({ ...claim, localProgress }, claim.launchId).localProgress;
    expect(validate(local)).toEqual(local);
    expect(validate({ ...local, startAtBeginning: true })).toEqual({
      ...local,
      startAtBeginning: true,
    });
    for (const changes of [
      { startAtBeginning: true, restore: localProgressFixture().restore },
      { startAtBeginning: true, restore: undefined },
      { startAtBeginning: false },
      { startAtBeginning: 'true' },
    ]) {
      expect(() => validate({ ...local, ...changes })).toThrow('reader_invalid_launch');
    }
  });

  it('isolates account, original prefix and version, preserving old local snapshots', () => {
    const a = launchFixture(claimFixture(undefined, localProgressFixture())).launch;
    const position = progressPayload({ location: 'epubcfi(/6/4!/4/2)' }, a);
    localStorage.setItem('moke-reader-progress-v1:["http://books.example/a","42"]', 'old snapshot');
    writeManagedProgress(a, position, localStorage);
    for (const claim of [
      claimFixture('http://books.example/b', localProgressFixture()),
      claimFixture(undefined, localProgressFixture({ accountId: 'other' })),
      claimFixture(undefined, localProgressFixture({ accountId: null })),
      claimFixture(undefined, localProgressFixture({ fileVersion: 'different-bytes' })),
      claimFixture(),
    ]) {
      expect(readManagedProgress(launchFixture(claim).launch, localStorage)).toBeNull();
    }
    expect(readManagedProgress(a, localStorage)).toEqual(position);
    expect(localStorage.getItem('moke-reader-progress-v1:["http://books.example/a","42"]')).toBe(
      'old snapshot',
    );
  });

  it('acknowledges restore in generation 1 and drains the trailing sequence after a safe retry', async () => {
    vi.useFakeTimers();
    const claim = claimFixture(undefined, localProgressFixture());
    const calls: Array<[string, Record<string, unknown>]> = [];
    const pendingClose = deferred<void>();
    let retried = false;
    const { launch, hint } = launchFixture(claim, async <T>(cmd: string, args = {}) => {
      calls.push([cmd, structuredClone(args)]);
      if (cmd === 'moke_reader_progress') {
        const result = retried
          ? { ...reservation(claim, { lastSequence: 1 }), localProgressStatus: 'saved' }
          : { ...reservation(claim), localProgressStatus: 'write-failed' };
        retried = true;
        return result as T;
      }
      if (cmd === 'moke_reader_closing') {
        const returned = calls.filter(([command]) => command === cmd).length > 1;
        return reservation(claim, {
          phase: returned ? 'returned' : 'closing',
          completion: returned ? 'complete' : 'pending',
          lastSequence: 1,
        }) as T;
      }
      return true as T;
    });
    launch.acknowledgeRestore('applied');
    launch.beginNavigation(2);
    launch.beginNavigation(3);
    await launch.progress({ location: 'old generation' }, 2);
    const payload = progressPayload({ location: 'epubcfi(/6/6!/4/2)' }, launch);
    const saved = launch.progress(payload, 3);
    const closing = launch.close().then(() => pendingClose.resolve());
    await vi.advanceTimersByTimeAsync(120);
    await saved;
    expect(calls.map(([command]) => command)).toEqual([
      'moke_reader_acknowledge_restore',
      'moke_reader_begin_navigation',
      'moke_reader_begin_navigation',
      'moke_reader_progress',
      'moke_reader_progress',
      'moke_reader_closing',
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      receipt: { id: 'restore-1', navigationGeneration: 1, outcome: 'applied' },
    });
    expect(calls[3]).toEqual(calls[4]);
    expect(calls[4]?.[1]).toMatchObject({ sequence: 1, navigationGeneration: 3, payload });
    hint({ launchId: claim.launchId, lastSequence: 0 });
    await Promise.resolve();
    expect(calls).toHaveLength(6);
    hint({ launchId: claim.launchId, lastSequence: 1 });
    await closing;
    await pendingClose.promise;
    expect(calls[6]?.[1]).toMatchObject({ lastSequence: 1 });
  });

  it('drops a superseded restore receipt and keeps a failed close unconfirmed', async () => {
    const claim = claimFixture(undefined, localProgressFixture());
    const invoke = vi.fn(async (command: string) =>
      command === 'moke_reader_begin_navigation'
        ? true
        : reservation(claim, { phase: 'returned', completion: 'failed' }),
    );
    const { launch } = launchFixture(
      claim,
      async <T>(command: string) => (await invoke(command)) as T,
    );
    launch.beginNavigation(2);
    launch.acknowledgeRestore('unavailable');
    await expect(launch.close()).rejects.toThrow();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'moke_reader_begin_navigation',
      'moke_reader_closing',
    ]);
  });
});
