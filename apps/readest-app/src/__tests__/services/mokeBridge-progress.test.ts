import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Verify the legacy bridge never posts progress through the HTTP plugin.
const { fetchMock, invokeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  invokeMock: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: fetchMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { mokeProgressStorageKey } from '@/helpers/mokeLaunchContext';
import {
  beginMokeAnnotationNavigation,
  cancelMokeAnnotationNavigation,
  captureMokeAnnotationNavigation,
  completeMokeAnnotationNavigation,
  emitReaderEvent,
  withMokeAnnotationNavigation,
} from '@/services/mokeBridge';

const SERVER_URL = 'http://192.168.1.5:8080';

describe('legacy Moke local progress and annotation correlation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ err: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    window.__MOKE_EMBEDDED = true;
    window.__MOKE_SERVER_URL = SERVER_URL;
    window.__MOKE_BOOK_ID = '42';
    window.__MOKE_RESTORE_PROGRESS = null;
    cancelMokeAnnotationNavigation(false);
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cancelMokeAnnotationNavigation(false);
    window.__MOKE_SERVER_URL = null;
    window.__MOKE_BOOK_ID = null;
    window.__MOKE_RESTORE_PROGRESS = null;
  });

  it('does not persist when no server URL is forwarded', async () => {
    window.__MOKE_SERVER_URL = null;

    void emitReaderEvent('page:changed', {
      book_id: 'abc123',
      location: 'epubcfi(/6/4!/4/2)',
    });

    await vi.advanceTimersByTimeAsync(1300);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves a local progress snapshot immediately even without a login/server URL', () => {
    window.__MOKE_SERVER_URL = null;

    void emitReaderEvent('page:changed', {
      book_id: 'abc123',
      location: 'epubcfi(/6/5)',
      page: 5,
      fraction: 0.05,
    });

    const stored = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).find((key) => key?.startsWith('moke:reading-progress:'));
    expect(stored).toBeTruthy();
    const progress = JSON.parse(localStorage.getItem(stored!)!);
    expect(progress.moke_book_id).toBe('42');
    expect(progress.location).toBe('epubcfi(/6/5)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('suppresses only correlated annotation navigation events, then saves the real page turn', async () => {
    window.__MOKE_RESTORE_PROGRESS = {
      location: 'epubcfi(/6/4!/4/2)',
      moke_navigation_id: 'locate-42',
      moke_navigation_kind: 'annotation-locate',
    };

    // A default startup relocate can arrive before the restore command starts.
    const startup = captureMokeAnnotationNavigation();
    void emitReaderEvent(
      'page:changed',
      withMokeAnnotationNavigation(
        { book_id: 'abc123', location: 'reader-default', page: 1 },
        startup,
      ),
    );

    beginMokeAnnotationNavigation();
    await vi.advanceTimersByTimeAsync(30_000); // slow book: no correctness grace window
    const restored = captureMokeAnnotationNavigation();
    completeMokeAnnotationNavigation();
    void emitReaderEvent(
      'page:changed',
      withMokeAnnotationNavigation(
        // Readest normalized the supplied CFI; correlation, not equality, wins.
        { book_id: 'abc123', location: 'epubcfi(/6/4!/4/2:0)', page: 12 },
        restored,
      ),
    );
    await vi.advanceTimersByTimeAsync(1_300);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);

    void emitReaderEvent('page:changed', {
      book_id: 'abc123',
      location: 'epubcfi(/6/6)',
      page: 13,
    });
    await vi.advanceTimersByTimeAsync(1_300);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(mokeProgressStorageKey(SERVER_URL, '42'))!).location,
    ).toBe('epubcfi(/6/6)');
  });

  it('notifies completion only after the terminal correlated page event is delivered', async () => {
    window.__MOKE_RESTORE_PROGRESS = {
      location: 'epubcfi(/6/4!/4/2)',
      moke_navigation_id: 'locate-ordered',
      moke_navigation_kind: 'annotation-locate',
    };

    let releasePageDelivery: (() => void) | undefined;
    const pageDelivery = new Promise<void>((resolve) => {
      releasePageDelivery = resolve;
    });
    const deliveredEvents: string[] = [];
    invokeMock.mockImplementation((_command: string, args: Record<string, unknown>) => {
      const event = String(args['event']);
      deliveredEvents.push(event);
      return event === 'page:changed' ? pageDelivery : Promise.resolve(undefined);
    });

    beginMokeAnnotationNavigation();
    const context = captureMokeAnnotationNavigation();
    const pageEvent = emitReaderEvent(
      'page:changed',
      withMokeAnnotationNavigation(
        { book_id: 'abc123', location: 'epubcfi(/6/4!/4/2:0)' },
        context,
      ),
    );
    completeMokeAnnotationNavigation();

    await Promise.resolve();
    await Promise.resolve();
    expect(deliveredEvents).toEqual(['page:changed']);

    releasePageDelivery?.();
    await pageEvent;
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveredEvents).toEqual(['page:changed', 'annotation-locate:finished']);
  });

  it('recycles annotation navigation state after failure and timeout', async () => {
    window.__MOKE_RESTORE_PROGRESS = {
      location: 'epubcfi(/6/4)',
      moke_navigation_id: 'locate-failure',
      moke_navigation_kind: 'annotation-locate',
    };
    beginMokeAnnotationNavigation();
    cancelMokeAnnotationNavigation();

    void emitReaderEvent('page:changed', { book_id: 'abc123', location: 'after-failure' });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(mokeProgressStorageKey(SERVER_URL, '42'))!).location,
    ).toBe('after-failure');

    fetchMock.mockClear();
    window.__MOKE_RESTORE_PROGRESS = {
      location: 'epubcfi(/6/8)',
      moke_navigation_id: 'locate-timeout',
      moke_navigation_kind: 'annotation-locate',
    };
    expect(captureMokeAnnotationNavigation()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1_000 + 1);
    expect(captureMokeAnnotationNavigation()).toBeNull();

    void emitReaderEvent('page:changed', { book_id: 'abc123', location: 'after-timeout' });
    await vi.advanceTimersByTimeAsync(1_300);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(mokeProgressStorageKey(SERVER_URL, '42'))!).location,
    ).toBe('after-timeout');
  });

  it('recycles annotation navigation state when the book closes', async () => {
    window.__MOKE_RESTORE_PROGRESS = {
      location: 'epubcfi(/6/4)',
      moke_navigation_id: 'locate-close',
      moke_navigation_kind: 'annotation-locate',
    };
    expect(captureMokeAnnotationNavigation()).not.toBeNull();

    await emitReaderEvent('book:closed', { book_id: 'abc123' });

    expect(captureMokeAnnotationNavigation()).toBeNull();
  });

  it('preserves the final local frame across close and pagehide without a direct POST', async () => {
    void emitReaderEvent('page:changed', { location: 'epubcfi(/6/10)', page: 10 });
    await emitReaderEvent('book:closed', {});
    window.dispatchEvent(new Event('pagehide'));
    await vi.runAllTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem(mokeProgressStorageKey(SERVER_URL, '42'))!),
    ).toMatchObject({ schema: 'moke.readest.progress.v1', location: 'epubcfi(/6/10)', page: 10 });
  });
});
