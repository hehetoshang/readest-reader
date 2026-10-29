import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    service, settingsStore, libraryStore, bookDataStore, readerStore,
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
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: mocks.envConfig, appService: mocks.service }) }));
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
  mocks.windowLabel = 'main';
  mocks.service.hasWindow = false;
  mocks.service.isDesktopApp = false;
  mocks.settingsStore.saveSettings.mockResolvedValue(undefined);
  mocks.readerStore.initViewState.mockResolvedValue(undefined);
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_RUNTIME_PLATFORM = 'android';
  window.OPEN_WITH_FILES = null;
  window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary&file=%2Fbooks%2Fbad.azw3');
});

afterEach(() => {
  cleanup();
  delete window.__MOKE_EMBEDDED;
  delete window.__MOKE_RUNTIME_PLATFORM;
  window.OPEN_WITH_FILES = null;
});

describe('Reader open recovery', () => {
  it('keeps a return action after importing every file failed with zero book keys', async () => {
    render(<ReaderContent settings={{} as SystemSettings} />);
    await screen.findByRole('heading', { name: 'Unable to open book' });
    const back = screen.getByRole('button', { name: 'Go Back' });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(back);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('moke_navigate', { path: '/library' }));
    expect(mocks.closeReaderWindowOrGoToLibrary).not.toHaveBeenCalled();
    expect(mocks.navigateToLibrary).not.toHaveBeenCalled();
  });

  it('uses the same recovery when initializing an existing book fails', async () => {
    window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary&ids=missing');
    mocks.bookKeys = ['missing-key'];
    mocks.readerStore.initViewState.mockRejectedValue(new Error('Book not found'));
    render(<ReaderContent settings={{} as SystemSettings} />);
    await screen.findByRole('heading', { name: 'Unable to open book' });
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('moke_navigate', { path: '/library' }));
  });

  it('lets an empty reader return even while bootstrap has not produced a book', async () => {
    window.history.replaceState({}, '', '/readest/reader?moke=1&mokeReturnTo=%2Flibrary');
    render(<ReaderContent settings={{} as SystemSettings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('moke_navigate', { path: '/library' }));
  });

  it('does not trap the error page when best-effort settings persistence rejects', async () => {
    mocks.settingsStore.saveSettings.mockRejectedValue(new Error('storage unavailable'));
    render(<ReaderContent settings={{} as SystemSettings} />);
    await screen.findByRole('heading', { name: 'Unable to open book' });
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('moke_navigate', { path: '/library' }));
  });

  it('closes a dedicated desktop reader through the existing window recovery', async () => {
    mocks.service.hasWindow = true;
    mocks.service.isDesktopApp = true;
    mocks.windowLabel = 'reader-1';
    window.__MOKE_RUNTIME_PLATFORM = 'windows';
    render(<ReaderContent settings={{} as SystemSettings} />);
    await screen.findByRole('heading', { name: 'Unable to open book' });
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(mocks.closeReaderWindowOrGoToLibrary).toHaveBeenCalledWith(mocks.service, mocks.router));
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
    render(<ReaderContent settings={{} as SystemSettings} />);
    await screen.findByRole('heading', { name: 'Unable to open book' });
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(mocks.closeWindow).toHaveBeenCalledOnce());
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });
});
