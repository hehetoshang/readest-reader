import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';

const mocks = vi.hoisted(() => {
  const saveSettings = vi.fn(async () => undefined);
  const initViewState = vi.fn(async () => undefined);
  const service = {
    hasWindow: false,
    isAndroidApp: true,
    isDesktopApp: false,
    allowPathsInScopes: vi.fn(async () => undefined),
    loadLibraryBooks: vi.fn(async () => []),
    openFile: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    importBook: vi.fn(async () => { throw new Error('Unsupported or corrupted book file'); }),
  };
  const settingsStore = {
    settings: {}, saveSettings, isSettingsDialogOpen: false, settingsDialogBookKey: null,
  };
  const libraryStore = {
    library: [], libraryLoaded: true, getBookByHash: vi.fn(), setLibrary: vi.fn(),
  };
  const bookDataStore = { getConfig: vi.fn(), getBookData: vi.fn(), saveConfig: vi.fn() };
  const readerStore = {
    initViewState, getViewState: vi.fn(), clearViewState: vi.fn(), getView: vi.fn(),
    setBookKeys: vi.fn(), getViewSettings: vi.fn(),
  };
  return {
    service, envService: service as typeof service | null,
    settingsStore, libraryStore, bookDataStore, readerStore,
    envConfig: { getAppService: vi.fn(async () => service) },
    router: { replace: vi.fn(), push: vi.fn() },
    bookKeys: [] as string[], windowLabel: 'main',
    invoke: vi.fn(async () => undefined), closeWindow: vi.fn(async () => undefined),
    closeReaderWindowOrGoToLibrary: vi.fn<typeof import('@/utils/nav').closeReaderWindowOrGoToLibrary>(async () => undefined),
    showMainWindow: vi.fn(async () => undefined),
    ensureMainLibraryWindow: vi.fn(async () => undefined),
    navigateToLibrary: vi.fn(), toast: vi.fn(),
  };
});

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: mocks.envConfig, appService: mocks.envService }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: Object.assign(() => mocks.settingsStore, { getState: () => mocks.settingsStore }) }));
vi.mock('@/store/libraryStore', () => ({ useLibraryStore: Object.assign(() => mocks.libraryStore, { getState: () => mocks.libraryStore }) }));
vi.mock('@/store/bookDataStore', () => ({ useBookDataStore: () => mocks.bookDataStore }));
vi.mock('@/store/readerStore', () => ({ useReaderStore: () => mocks.readerStore }));
vi.mock('@/store/sidebarStore', () => ({ useSidebarStore: () => ({ sideBarBookKey: null, setSideBarBookKey: vi.fn() }) }));
vi.mock('@/app/reader/hooks/useBooksManager', () => ({ default: () => ({ bookKeys: mocks.bookKeys, dismissBook: vi.fn(), getNextBookKey: vi.fn() }) }));
vi.mock('@/app/reader/hooks/useBookShortcuts', () => ({ default: vi.fn() }));
vi.mock('@/app/reader/hooks/useMokeCommandListener', () => ({ useMokeCommandListener: vi.fn() }));
vi.mock('@/app/reader/hooks/useMokeRemoteSourceError', () => ({ useMokeRemoteSourceError: vi.fn() }));
vi.mock('@/hooks/useAndroidGamepadConnection', () => ({ useAndroidGamepadConnection: () => false }));
vi.mock('@/hooks/useGamepad', () => ({ useGamepad: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/helpers/openWith', () => ({ parseOpenWithFiles: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: mocks.windowLabel, close: mocks.closeWindow }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async () => ({
      show: mocks.showMainWindow,
      unminimize: vi.fn(async () => undefined),
      setFocus: vi.fn(async () => undefined),
    })),
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/window', () => ({ tauriHandleClose: vi.fn(), tauriHandleOnCloseWindow: vi.fn(async () => vi.fn()) }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/services/constants', () => ({ BOOK_IDS_SEPARATOR: '+' }));
vi.mock('@/utils/audiobook', () => ({ splitLibraryOpenIds: (readerIds: string[]) => ({ readerIds }) }));
vi.mock('@/utils/misc', () => ({ uniqueId: () => 'key' }));
vi.mock('@/utils/md5', () => ({ partialMD5: vi.fn(async () => undefined) }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: mocks.toast, on: vi.fn(), off: vi.fn(), onSync: vi.fn(), offSync: vi.fn() } }));
vi.mock('@/utils/nav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/nav')>();
  mocks.closeReaderWindowOrGoToLibrary.mockImplementation(actual.closeReaderWindowOrGoToLibrary);
  return {
    ...actual,
    closeReaderWindowOrGoToLibrary: mocks.closeReaderWindowOrGoToLibrary,
    ensureMainLibraryWindow: mocks.ensureMainLibraryWindow,
    navigateToLibrary: mocks.navigateToLibrary,
  };
});
vi.mock('@/utils/discord', () => ({ clearDiscordPresence: vi.fn() }));
vi.mock('@/services/mokeBridge', () => ({ emitReaderEvent: vi.fn(async () => undefined) }));
vi.mock('@/services/mokeRemoteSource', () => ({
  isMokeRemoteSourceUrl: () => false,
  mokeRemoteSourceErrorDetail: () => null,
}));
vi.mock('@/components/Spinner', () => ({ default: () => <div role='status'>Loading</div> }));
vi.mock('@/app/reader/components/sidebar/SideBar', () => ({ default: () => null }));
vi.mock('@/app/reader/components/notebook/LazyNotebook', () => ({ default: () => null }));
vi.mock('@/components/localsend/LocalSendManager', () => ({ default: () => null }));
vi.mock('@/app/reader/components/BooksGrid', () => ({ default: () => null }));

import ReaderContent from '@/app/reader/components/ReaderContent';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookKeys = [];
  mocks.envService = mocks.service;
  mocks.windowLabel = 'main';
  mocks.service.hasWindow = false;
  mocks.service.isDesktopApp = false;
  vi.useFakeTimers();
  mocks.settingsStore.saveSettings.mockResolvedValue(undefined);
  mocks.service.importBook.mockRejectedValue(new Error('Unsupported or corrupted book file'));
  mocks.readerStore.initViewState.mockResolvedValue(undefined);
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_RUNTIME_PLATFORM = 'android';
  window.OPEN_WITH_FILES = null;
  window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary&file=%2Fbooks%2Fbad.azw3');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__MOKE_EMBEDDED;
  delete window.__MOKE_RUNTIME_PLATFORM;
  window.OPEN_WITH_FILES = null;
});

async function renderReader() {
  await act(async () => {
    render(<ReaderContent settings={{} as SystemSettings} />);
  });
}

async function finishErrorNotice() {
  await act(async () => vi.advanceTimersByTimeAsync(2000));
}

describe('Reader open recovery', () => {
  it('automatically returns after a failed import without a separate content button', async () => {
    await renderReader();
    expect(screen.getByRole('heading', { name: 'Unable to open book' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Go Back' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('toast', expect.objectContaining({
      message: 'Unable to open book', timeout: 2000, type: 'error',
    }));
    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
    expect(mocks.closeReaderWindowOrGoToLibrary).not.toHaveBeenCalled();
    expect(mocks.navigateToLibrary).not.toHaveBeenCalled();
  });

  it('recovers only once when StrictMode replays mount effects', async () => {
    await act(async () => {
      render(<StrictMode><ReaderContent settings={{} as SystemSettings} /></StrictMode>);
    });
    await finishErrorNotice();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
  });

  it('uses the same recovery when initializing an existing book fails', async () => {
    window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary&ids=missing');
    mocks.bookKeys = ['missing-key'];
    mocks.readerStore.initViewState.mockRejectedValue(new Error('Book not found'));
    await renderReader();
    expect(screen.getByRole('heading', { name: 'Unable to open book' })).not.toBeNull();
    await finishErrorNotice();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
  });

  it('returns an empty route without displaying a standalone back button', async () => {
    window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary');
    await renderReader();
    expect(screen.queryByRole('button', { name: 'Go Back' })).toBeNull();
    await finishErrorNotice();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
  });

  it('uses the ready native service when recovering an initially empty desktop reader', async () => {
    mocks.envService = null;
    mocks.service.hasWindow = true;
    mocks.service.isDesktopApp = true;
    mocks.windowLabel = 'reader-1';
    window.__MOKE_RUNTIME_PLATFORM = 'windows';
    window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary');
    const view = render(<ReaderContent settings={{} as SystemSettings} />);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    mocks.envService = mocks.service;
    await act(async () => view.rerender(<ReaderContent settings={{} as SystemSettings} />));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.closeReaderWindowOrGoToLibrary).toHaveBeenCalledWith(mocks.service, mocks.router);
    expect(mocks.closeWindow).toHaveBeenCalledOnce();
  });

  it.each(['mobile', 'desktop'])('does not cancel a slow valid %s import', async (platform) => {
    mocks.service.importBook.mockImplementation(() => new Promise(() => {}));
    if (platform === 'desktop') {
      window.history.replaceState({}, '', '/readest/reader');
      window.OPEN_WITH_FILES = ['/books/slow.epub'];
      window.__MOKE_RUNTIME_PLATFORM = 'windows';
    }
    await renderReader();
    expect(screen.getByRole('status')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.closeReaderWindowOrGoToLibrary).not.toHaveBeenCalled();
  });

  it('cancels pending automatic recovery when the reader is unmounted', async () => {
    await renderReader();
    cleanup();
    await finishErrorNotice();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('does not trap the error page when best-effort settings persistence rejects', async () => {
    mocks.settingsStore.saveSettings.mockRejectedValue(new Error('storage unavailable'));
    await renderReader();
    await finishErrorNotice();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
  });

  it('bounds failed-open cleanup before returning to the host', async () => {
    mocks.settingsStore.saveSettings.mockImplementation(() => new Promise(() => {}));
    await renderReader();
    await finishErrorNotice();
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1499));
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('moke_navigate', { path: '/library' });
  });

  it('closes a dedicated desktop reader through the existing window recovery', async () => {
    mocks.service.hasWindow = true;
    mocks.service.isDesktopApp = true;
    mocks.windowLabel = 'reader-1';
    window.__MOKE_RUNTIME_PLATFORM = 'windows';
    await renderReader();
    await finishErrorNotice();
    expect(mocks.closeReaderWindowOrGoToLibrary).toHaveBeenCalledWith(mocks.service, mocks.router);
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.closeWindow).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps the dedicated-window close behavior for a standalone Reader', async () => {
    mocks.service.hasWindow = true;
    mocks.service.isDesktopApp = true;
    mocks.windowLabel = 'reader-1';
    window.__MOKE_RUNTIME_PLATFORM = 'windows';
    window.history.replaceState({}, '', '/readest/reader');
    window.OPEN_WITH_FILES = ['/books/bad.azw3'];
    await renderReader();
    await finishErrorNotice();
    expect(mocks.closeWindow).toHaveBeenCalledOnce();
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });
});
