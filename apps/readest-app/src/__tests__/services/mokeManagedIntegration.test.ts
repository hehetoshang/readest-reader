import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { claimFixture, reservation } from '../helpers/hostLaunchFixture';
import { MokeHostLaunch } from '@/services/mokeHostLaunch';

const fixture = vi.hoisted(() => ({
  launch: null as MokeHostLaunch | null,
  invoke: vi.fn(),
  directPost: vi.fn(),
}));
vi.mock('@/services/mokeHostLaunch', async (original) => ({
  ...(await original<typeof import('@/services/mokeHostLaunch')>()),
  getMokeHostLaunch: () => fixture.launch,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: fixture.directPost }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ listen: vi.fn(async () => () => {}) }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  localStorage.clear();
  fixture.launch = null;
  window.history.replaceState(null, '', '/readest/reader');
  window.__MOKE_EMBEDDED = false;
});
afterEach(() => {
  vi.useRealTimers();
  fixture.launch = null;
});

describe('complete progress identity, relay and return integration', () => {
  it('separates same-byte hashes, config restore and snapshots for /a and /b; leaves offline and anonymous state intact', async () => {
    const { managedBookFields, restoreManagedConfig, progressPayload, writeManagedProgress } =
      await import('@/services/mokeProgressIdentity');
    localStorage.setItem('moke:reading-progress::42', '{"location":"anonymous-original"}');
    const c = claimFixture();
    fixture.launch = new MokeHostLaunch(c, fixture.invoke, async () => () => {});
    const a = managedBookFields(c.resource.url, 'same-content-hash');
    writeManagedProgress(
      fixture.launch,
      progressPayload({ location: 'A', page: 3, total_pages: 10 }, fixture.launch),
      localStorage,
    );
    const bClaim = claimFixture('http://books.example/b');
    fixture.launch = new MokeHostLaunch(bClaim, fixture.invoke, async () => () => {});
    const b = managedBookFields(bClaim.resource.url, 'same-content-hash');
    const offline = managedBookFields('/local/offline.epub', 'same-content-hash');
    expect(a.hash).not.toBe(b.hash);
    expect(offline).toEqual({ hash: 'same-content-hash' });
    expect(restoreManagedConfig(b as Book, { updatedAt: 0 }).location).toBeUndefined();
    writeManagedProgress(
      fixture.launch,
      progressPayload({ location: 'B', page: 7, total_pages: 10 }, fixture.launch),
      localStorage,
    );
    expect(restoreManagedConfig(b as Book, { updatedAt: 0 }).location).toBe('B');
    fixture.launch = new MokeHostLaunch(c, fixture.invoke, async () => () => {});
    expect(restoreManagedConfig(a as Book, { updatedAt: 0 })).toMatchObject({
      location: 'A',
      progress: [3, 10],
    });
    expect(
      restoreManagedConfig(a as Book, { updatedAt: Date.now() + 1000, location: 'newer-config' })
        .location,
    ).toBe('newer-config');
    expect(localStorage.getItem('moke:reading-progress::42')).toBe(
      '{"location":"anonymous-original"}',
    );
  });
  it('flushes the trailing relocate once, saves locally under the full identity and delegates every remote save to host', async () => {
    vi.useFakeTimers();
    const c = claimFixture();
    fixture.invoke.mockImplementation(async (command, args) => {
      if (command === 'moke_reader_progress')
        return reservation(c, { lastSequence: Number(args['sequence']) });
      if (command === 'moke_reader_closing')
        return reservation(c, { lastSequence: 1, phase: 'returned', completion: 'complete' });
      return undefined;
    });
    fixture.launch = new MokeHostLaunch(c, fixture.invoke, async () => () => {});
    window.__MOKE_EMBEDDED = true;
    // Even an old global server value cannot produce a managed direct POST.
    window.__MOKE_SERVER_URL = 'http://old.example';
    const { emitReaderEvent } = await import('@/services/mokeBridge');
    await emitReaderEvent('page:changed', { book_id: 'same-bytes', location: 'first' });
    await emitReaderEvent('page:changed', { book_id: 'same-bytes', location: 'last' });
    await emitReaderEvent('book:closed', {});
    await emitReaderEvent('page:changed', { location: 'late' });
    await vi.runAllTimersAsync();
    const calls = fixture.invoke.mock.calls.filter(
      ([command]) => command === 'moke_reader_progress',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      sequence: 1,
      payload: { location: 'last', reader_book_id: 'same-bytes' },
    });
    expect(
      JSON.parse(localStorage.getItem(`moke-reader-progress-v2:${fixture.launch.identity}`)!)[
        'location'
      ],
    ).toBe('last');
    expect(fixture.directPost).not.toHaveBeenCalled();
  });
  it('unknown closing never navigates, including the old recovery timeout path', async () => {
    vi.useFakeTimers();
    const c = claimFixture();
    fixture.invoke.mockResolvedValue(reservation(c, { phase: 'closing', completion: 'unknown' }));
    fixture.launch = new MokeHostLaunch(c, fixture.invoke, async () => () => {});
    const { closeReaderAndNavigateBack } = await import('@/utils/readerBack');
    const navigate = vi.fn();
    await expect(closeReaderAndNavigateBack(async () => {}, navigate, 1)).rejects.toThrow();
    await vi.runAllTimersAsync();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('closes the claimed dedicated window without a legacy return query, only after host return', async () => {
    const c = claimFixture();
    fixture.invoke.mockResolvedValue(reservation(c, { phase: 'returned', completion: 'complete' }));
    fixture.launch = new MokeHostLaunch(c, fixture.invoke, async () => () => {});
    const { navigateReaderBack } = await import('@/utils/readerBack');
    const close = vi.fn(async () => {}),
      navigate = vi.fn();
    await navigateReaderBack({
      search: '?moke=1&mokeLaunchId=synthetic-launch',
      isReaderWindow: true,
      closeReaderOrGoToLibrary: close,
      navigateMoke: navigate,
      navigateReadestLibrary: navigate,
      navigateDocument: navigate,
      onNativeNavigationError: navigate,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.invoke).toHaveBeenCalledWith(
      'moke_reader_closing',
      expect.objectContaining({ lastSequence: 0 }),
    );
  });
});
