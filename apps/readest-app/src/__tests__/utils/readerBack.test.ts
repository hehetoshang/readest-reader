import { describe, expect, it, vi } from 'vitest';

import {
  closeReaderAndNavigateBack,
  navigateReaderBack,
  resolveReaderReturnTarget,
} from '@/utils/readerBack';

describe('closeReaderAndNavigateBack', () => {
  it('bounds only error recovery when cleanup never completes', async () => {
    vi.useFakeTimers();
    try {
      const navigateBack = vi.fn();
      const closing = closeReaderAndNavigateBack(() => new Promise(() => {}), navigateBack, 1500);
      const rejected = expect(closing).rejects.toThrow('Reader recovery cleanup timed out');
      await vi.advanceTimersByTimeAsync(1499);
      expect(navigateBack).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(navigateBack).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('waits for progress persistence before navigating back', async () => {
    let finishSaving: (() => void) | undefined;
    const closeReader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSaving = resolve;
        }),
    );
    const navigateBack = vi.fn();

    const closing = closeReaderAndNavigateBack(closeReader, navigateBack);
    await Promise.resolve();

    expect(closeReader).toHaveBeenCalledTimes(1);
    expect(navigateBack).not.toHaveBeenCalled();

    finishSaving?.();
    await closing;

    expect(navigateBack).toHaveBeenCalledTimes(1);
  });

  it('still navigates back when a best-effort save fails', async () => {
    const navigateBack = vi.fn();

    await expect(
      closeReaderAndNavigateBack(() => Promise.reject(new Error('disk unavailable')), navigateBack),
    ).rejects.toThrow('disk unavailable');

    expect(navigateBack).toHaveBeenCalledTimes(1);
  });

  it('waits for asynchronous native navigation to finish', async () => {
    let finishNavigation: (() => void) | undefined;
    const navigateBack = vi.fn(() => new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }));
    const finished = vi.fn();
    const closing = closeReaderAndNavigateBack(async () => undefined, navigateBack).then(finished);
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    finishNavigation?.();
    await closing;
    expect(finished).toHaveBeenCalledOnce();
  });
});

describe('navigateReaderBack', () => {
  const createNavigation = () => ({
    search: '?moke=1&mokeReturnTo=%2Flibrary',
    runtimePlatform: 'android',
    isReaderWindow: false,
    recover: true,
    navigateMoke: vi.fn(async () => undefined),
    closeReaderOrGoToLibrary: vi.fn(async () => undefined),
    navigateReadestLibrary: vi.fn(),
    navigateDocument: vi.fn(),
    onNativeNavigationError: vi.fn(),
  });

  it.each(['android', 'ohos'])('returns %s to the host through native navigation', async (runtimePlatform) => {
    const navigation = { ...createNavigation(), runtimePlatform };
    await navigateReaderBack(navigation);
    expect(navigation.navigateMoke).toHaveBeenCalledExactlyOnceWith('/library');
    expect(navigation.closeReaderOrGoToLibrary).not.toHaveBeenCalled();
    expect(navigation.navigateDocument).not.toHaveBeenCalled();
  });

  it.each(['android', 'ohos'])('falls back to a host document when %s native navigation rejects', async (runtimePlatform) => {
    const navigation = { ...createNavigation(), runtimePlatform };
    const error = new Error('native navigation unavailable');
    navigation.navigateMoke.mockRejectedValue(error);
    await navigateReaderBack(navigation);
    expect(navigation.navigateDocument).toHaveBeenCalledExactlyOnceWith('/library');
    expect(navigation.closeReaderOrGoToLibrary).not.toHaveBeenCalled();
    expect(navigation.onNativeNavigationError).toHaveBeenCalledWith(error);
  });

  it('uses existing window recovery for a dedicated desktop reader', async () => {
    const navigation = { ...createNavigation(), runtimePlatform: 'windows', isReaderWindow: true };
    await navigateReaderBack(navigation);
    expect(navigation.closeReaderOrGoToLibrary).toHaveBeenCalledOnce();
    expect(navigation.navigateMoke).not.toHaveBeenCalled();
    expect(navigation.navigateDocument).not.toHaveBeenCalled();
  });

  it('uses a full host document outside the mobile native platforms', async () => {
    const navigation = { ...createNavigation(), runtimePlatform: 'ios' };
    await navigateReaderBack(navigation);
    expect(navigation.navigateDocument).toHaveBeenCalledExactlyOnceWith('/library');
    expect(navigation.closeReaderOrGoToLibrary).not.toHaveBeenCalled();
  });

  it.each(['?ids=book', '?moke=1&mokeReturnTo=https%3A%2F%2Fevil.example'])('preserves standalone Reader recovery for %s', async (search) => {
    const navigation = { ...createNavigation(), search };
    await navigateReaderBack(navigation);
    expect(navigation.closeReaderOrGoToLibrary).toHaveBeenCalledOnce();
    expect(navigation.navigateMoke).not.toHaveBeenCalled();
    expect(navigation.navigateDocument).not.toHaveBeenCalled();
  });

  it('preserves normal standalone Reader library navigation', async () => {
    const navigation = { ...createNavigation(), search: '?ids=book', recover: false };
    await navigateReaderBack(navigation);
    expect(navigation.navigateReadestLibrary).toHaveBeenCalledOnce();
    expect(navigation.closeReaderOrGoToLibrary).not.toHaveBeenCalled();
  });
});

describe('resolveReaderReturnTarget', () => {
  it('returns the Moke library for a book launched directly by Moke', () => {
    expect(resolveReaderReturnTarget('?moke=1&mokeReturnTo=%2Flibrary')).toEqual({
      kind: 'moke',
      path: '/library',
    });
  });

  it('returns the Readest library for books opened from its embedded home', () => {
    expect(resolveReaderReturnTarget('?ids=book-1')).toEqual({ kind: 'readest' });
  });

  it('does not accept an arbitrary Moke return URL', () => {
    expect(resolveReaderReturnTarget('?moke=1&mokeReturnTo=https%3A%2F%2Fevil.example')).toEqual({
      kind: 'readest',
    });
  });
});
