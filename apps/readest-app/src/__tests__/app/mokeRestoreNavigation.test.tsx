import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMokeCommandListener } from '@/app/reader/hooks/useMokeCommandListener';

const mocks = vi.hoisted(() => ({
  view: { hasUserNavigation: false, goTo: vi.fn(async () => {}) },
  emit: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: {
    getState: () => ({
      viewStates: { book: { isPrimary: true } },
      getView: () => mocks.view,
    }),
    subscribe: mocks.subscribe,
  },
}));
vi.mock('@/services/mokeBridge', () => ({
  emitReaderEvent: mocks.emit,
  beginMokeAnnotationNavigation: vi.fn(),
  completeMokeAnnotationNavigation: vi.fn(),
  cancelMokeAnnotationNavigation: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: async () => vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.view.hasUserNavigation = false;
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_RESTORE_PROGRESS = { location: 'saved' };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.__MOKE_EMBEDDED = false;
  window.__MOKE_RESTORE_PROGRESS = undefined;
});

it('restores an untouched view after initialization', async () => {
  renderHook(() => useMokeCommandListener(['book']));
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.view.goTo).toHaveBeenCalledWith('saved');
  expect(mocks.emit).toHaveBeenCalledWith(
    'command:result',
    expect.objectContaining({
      success: true,
      result: { restored: true },
    }),
  );
});

it('does not enqueue the launch restore after a newer jump or turn was accepted', async () => {
  renderHook(() => useMokeCommandListener(['book']));
  mocks.view.hasUserNavigation = true;
  await vi.advanceTimersByTimeAsync(250);
  expect(mocks.view.goTo).not.toHaveBeenCalled();
  expect(mocks.emit).toHaveBeenCalledWith(
    'command:result',
    expect.objectContaining({
      success: true,
      result: { restored: false, reason: 'superseded-by-reading-action' },
    }),
  );
});
