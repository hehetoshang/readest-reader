import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIMED_DOWNLOAD_PATH,
  MAX_DOWNLOAD_READ_BYTES,
  MokeHostLaunch,
  type ReaderInvoke,
  validateReaderClaim,
} from '@/services/mokeHostLaunch';
import { openMokeDownloadedEpub } from '@/services/mokeDownloadedEpub';
import { createMokeRemoteSourceTransport } from '@/services/mokeRemoteSource';
import {
  claimFixture,
  deferred,
  downloadedClaimFixture,
  launchFixture,
  localProgressFixture,
  reservation,
} from '../helpers/hostLaunchFixture';

const fixture = vi.hoisted(() => ({ launch: null as MokeHostLaunch | null }));
vi.mock('@/services/mokeHostLaunch', async (original) => ({
  ...(await original<typeof import('@/services/mokeHostLaunch')>()),
  getMokeHostLaunch: () => fixture.launch,
}));

beforeEach(() => {
  fixture.launch = null;
});

describe('native claim for one downloaded EPUB', () => {
  const claim = downloadedClaimFixture();
  const restore = localProgressFixture().restore!;

  it.each([
    { resource: { ...claim.resource, url: 'asset://localhost/book.epub' } },
    { resource: { ...claim.resource, path: '/downloads/book.epub' } },
    { resource: { ...claim.resource, size: 0 } },
    { resource: { ...claim.resource, kind: 'other' } },
    { resource: { ...claim.resource, fileVersion: 'other' } },
    { localProgress: undefined },
    { localProgress: localProgressFixture({ accountId: null }) },
    {
      localProgress: localProgressFixture({
        restore: { ...restore, position: { ...restore.position, moke_book_id: '43' } },
      }),
    },
  ])('rejects an inconsistent or unowned download claim: %j', (change) => {
    expect(() => validateReaderClaim({ ...claim, ...change }, claim.launchId)).toThrow();
  });

  it('uses the same progress identity as an online claim of the identical version', () => {
    const online = launchFixture(claimFixture(claim.source.libraryBaseUrl, claim.localProgress));
    const download = launchFixture(claim);
    expect(download.launch.sourcePath).toBe(CLAIMED_DOWNLOAD_PATH);
    expect(download.launch.identity).toBe(online.launch.identity);
    const newAccount = downloadedClaimFixture(
      localProgressFixture({ accountId: '8', restore: null }),
    );
    expect(launchFixture(newAccount).launch.identity).not.toBe(download.launch.identity);
    expect(newAccount.localProgress?.restore).toBeNull();
  });

  it('requires a downloaded claim and reads through the existing File slice interface', async () => {
    await expect(openMokeDownloadedEpub()).rejects.toThrow('reader_invalid_launch');
    const invoke = vi.fn(async () => new Uint8Array(claim.resource.size).fill(17).buffer);
    fixture.launch = launchFixture(claim, invoke as ReaderInvoke).launch;
    expect(() =>
      createMokeRemoteSourceTransport('http://books.example/a/api/book/42.epub'),
    ).toThrow();
    const file = await openMokeDownloadedEpub();
    expect(file.type).toBe('application/epub+zip');
    expect(file.size).toBe(claim.resource.size);
    expect(Array.from(new Uint8Array(await file.slice(23, 28).arrayBuffer()))).toEqual([
      17, 17, 17, 17, 17,
    ]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('moke_reader_download_read', {
      launchId: claim.launchId,
      claimToken: claim.claimToken,
      offset: 0,
      length: claim.resource.size,
    });
    await file.close();
    await expect(file.slice(23, 28).arrayBuffer()).rejects.toThrow('Download reader closed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects out-of-scope ranges before invoking native code', async () => {
    const invoke = vi.fn();
      const { launch } = launchFixture(claim, invoke);
    for (const [offset, length] of [
      [0.5, 1],
      [0, 0],
      [1000, 1],
      [0, MAX_DOWNLOAD_READ_BYTES + 1],
    ] as const) {
      await expect(launch.readDownloadedRange(offset, length)).rejects.toThrow(
        'reader_invalid_launch',
      );
    }
    await expect(
      launchFixture(claimFixture(), invoke).launch.readDownloadedRange(0, 1),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    'short read',
    'expired claim',
    'account changed',
  ])('stops on %s without replaying the read or claiming a successful return', async (failure) => {
    const invoke = vi.fn(async () => {
      if (failure === 'short read') return [80];
      throw new Error(failure);
    });
    const { launch } = launchFixture(claim, invoke as ReaderInvoke);
    await expect(launch.readDownloadedRange(0, 2)).rejects.toThrow('reader_download_unavailable');
    await expect(launch.readDownloadedRange(0, 2)).rejects.toThrow('reader_launch_unknown');
    await expect(launch.close()).rejects.toThrow('reader_launch_unknown');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('drains an in-flight native read and the final progress frame before returning', async () => {
    const nativeRead = deferred<number[]>();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'moke_reader_download_read') return await nativeRead.promise;
      if (command === 'moke_reader_progress')
        return { ...reservation(claim, { lastSequence: 1 }), localProgressStatus: 'saved' };
      return reservation(claim, { lastSequence: 1, phase: 'returned', completion: 'complete' });
    });
    const { launch } = launchFixture(claim, invoke as ReaderInvoke);
    const range = launch.readDownloadedRange(0, 1);
    const discarded = expect(range).rejects.toThrow('reader_launch_unknown');
    await launch.progress({ location: 'epubcfi(/6/4!/4/2)' }, 1);
    const closing = launch.close();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'moke_reader_download_read',
      'moke_reader_progress',
    ]);
    nativeRead.resolve([80]);
    await discarded;
    await closing;
    expect(invoke).toHaveBeenLastCalledWith('moke_reader_closing', {
      launchId: claim.launchId,
      claimToken: claim.claimToken,
      lastSequence: 1,
    });
  });
});
