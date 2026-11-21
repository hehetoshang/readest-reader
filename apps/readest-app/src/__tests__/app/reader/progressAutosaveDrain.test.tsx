import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { eventDispatcher } from '@/utils/event';
import { useProgressAutoSave } from '@/app/reader/hooks/useProgressAutoSave';
import { deferred } from '../../helpers/hostLaunchFixture';

const fixture = vi.hoisted(() => ({
  location: 'loaded',
  progress: 0,
  save: vi.fn(),
  unknown: vi.fn(),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/bookDataStore', () => {
  const store = {
    getConfig: () => ({ location: fixture.location }),
    saveConfig: fixture.save,
  };
  return {
    useBookDataStore: (select: (state: typeof store) => unknown) => select(store),
    flushPendingLibrarySave: async () => {},
  };
});
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ getViewState: () => ({}) }) },
}));
vi.mock('@/store/readerProgressStore', () => ({ useBookProgress: () => fixture.progress }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/services/mokeHostLaunch', () => ({
  getMokeHostLaunch: () => ({ isActive: () => true, markUnknown: fixture.unknown }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('drains an accepted autosave and stops future debounce writes before managed closing', async () => {
  vi.useFakeTimers();
  const writing = deferred<void>();
  fixture.save.mockReturnValue(writing.promise);
  const hook = renderHook(() => useProgressAutoSave('book-1'));
  fixture.location = 'last-page';
  fixture.progress++;
  hook.rerender();
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(fixture.save).toHaveBeenCalledOnce();
  let drained = false;
  const stop = eventDispatcher.dispatch('stop-reader-autosave', { bookKey: 'book-1' }).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  writing.resolve();
  await stop;
  fixture.location = 'late';
  fixture.progress++;
  hook.rerender();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.save).toHaveBeenCalledOnce();
  expect(fixture.unknown).not.toHaveBeenCalled();
  hook.unmount();
});
