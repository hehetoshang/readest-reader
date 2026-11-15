import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { FoliateView } from '@/types/view';
import type { Insets } from '@/types/misc';
import type { Book, BookConfig, BookContent, ViewSettings } from '@/types/book';

vi.mock('@/store/bookDataStore', async () => {
  const { create } = await import('zustand');
  return {
    useBookDataStore: create(() => ({
      booksData: {} as Record<string, unknown>,
      getBookData(id: string): unknown { return this.booksData[id]; },
      clearBookData(id: string) {
        const booksData = { ...this.booksData };
        delete booksData[id];
        this.booksData = booksData;
      },
    })),
  };
});

vi.mock('@/store/settingsStore', () => {
  const { create } = require('zustand');
  return {
    useSettingsStore: create(() => ({
      settings: {},
    })),
  };
});

vi.mock('@/store/libraryStore', () => {
  const { create } = require('zustand');
  return {
    useLibraryStore: create(() => ({
      library: [],
      hashIndex: new Map(),
      setLibrary: vi.fn(),
      getBookByHash: vi.fn(),
      updateBookProgress: vi.fn(),
      rebuildHashIndex: vi.fn(),
    })),
  };
});

vi.mock('@/utils/misc', () => ({
  uniqueId: vi.fn(() => 'mock-uid-123'),
}));

// These are transitive imports needed by readerStore
vi.mock('@/services/nav', () => ({
  computeBookNav: vi.fn(),
  hydrateBookNav: vi.fn(),
  isBookNavCacheCurrent: vi.fn(() => true),
  updateToc: vi.fn(),
}));
vi.mock('@/utils/book', () => ({
  formatTitle: vi.fn((t: string) => t),
  getMetadataHash: vi.fn(() => 'hash'),
  getPrimaryLanguage: vi.fn(() => 'en'),
}));
vi.mock('@/utils/path', () => ({
  getBaseFilename: vi.fn((n: string) => n),
}));
vi.mock('@/services/constants', () => ({
  SUPPORTED_LANGNAMES: {},
}));
vi.mock('@/libs/document', () => ({
  DocumentLoader: vi.fn(),
}));
vi.mock('@/services/opds/pseStream', () => ({
  isPseStreamFileName: () => false,
  openPseStreamBook: vi.fn(),
  parsePseStreamFileName: vi.fn(),
}));
vi.mock('@/services/rss/feedBookUrl', () => ({
  isFeedBookUrl: () => false,
  parseFeedBookUrl: vi.fn(),
}));
vi.mock('@/services/rss/feedReader', () => ({
  openFeedBookDoc: vi.fn(),
}));
const tts = vi.hoisted(() => ({ held: false }));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: { hasBookResources: () => tts.held },
}));

import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import { computeBookNav, hydrateBookNav, isBookNavCacheCurrent } from '@/services/nav';
import { uniqueId } from '@/utils/misc';
import { releaseUnusedBookData } from '@/services/bookResourceLifetime';
import { createBookRendererLifetime } from '@/services/bookRendererLifetime';
import { BookDocumentOwner } from '@/services/bookDocumentOwner';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycleFixture(id: string) {
  useReaderStore.setState({ viewStates: {} });
  useBookDataStore.setState({ booksData: {} });
  tts.held = false;
  const documents: Array<{ metadata: object; rendition: object; destroy: ReturnType<typeof vi.fn> }> = [];
  const files: Array<File & { close: ReturnType<typeof vi.fn> }> = [];
  const book = { hash: id, format: 'PDF' } as Book;
  const service = {
    loadBookContent: vi.fn(async (): Promise<BookContent> => {
      const file = Object.assign(new File(['pdf'], 'book.pdf'), { close: vi.fn(async () => {}) });
      files.push(file);
      return { book, file };
    }),
    loadBookConfig: vi.fn(async () => ({ viewSettings: {}, booknotes: [] })),
  };
  vi.mocked(useLibraryStore.getState().getBookByHash).mockReturnValue(book);
  useSettingsStore.setState({ settings: { globalViewSettings: {} } as never });
  const open = vi.fn(async () => {
    const document = { metadata: {}, rendition: {}, destroy: vi.fn(async () => {}) };
    documents.push(document);
    return { book: document as unknown as BookDoc };
  });
  vi.mocked(DocumentLoader).mockImplementation(function () { return { open }; } as never);
  const env = { getAppService: async () => service } as never;
  const init = (key = `${id}-0`, reload = false) =>
    useReaderStore.getState().initViewState(env, id, key, true, reload);
  const close = (key = `${id}-0`) => {
    useReaderStore.getState().clearViewState(key);
    return releaseUnusedBookData(id);
  };
  return { documents, files, service, open, init, close };
}

describe('SOL-001 reload generation ownership', () => {
  test('completed production reloads release old generations while the current view stays open', async () => {
    const f = lifecycleFixture('generations');
    await f.init();
    for (let i = 0; i < 6; i++) {
      useReaderStore.getState().recreateViewer({ getAppService: async () => f.service } as never, 'generations-0');
      await vi.waitFor(() => expect(f.documents).toHaveLength(i + 2));
      await vi.waitFor(() => expect(useReaderStore.getState().getViewState('generations-0')?.loading).toBe(false));
      await releaseUnusedBookData('generations');
      expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([...Array(i + 1).fill(1), 0]);
      expect(f.files.map(file => file.close.mock.calls.length)).toEqual([...Array(i + 1).fill(1), 0]);
    }
    await Promise.all([f.close(), releaseUnusedBookData('generations')]);
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual(Array(7).fill(1));
    expect(f.files.map(file => file.close.mock.calls.length)).toEqual(Array(7).fill(1));
    await releaseUnusedBookData('generations');
    for (const doc of f.documents) expect(doc.destroy).toHaveBeenCalledOnce();
  });

  test('keeps old parallel-view and background-TTS generations through the last holder', async () => {
    const f = lifecycleFixture('holders');
    await f.init();
    await f.init('holders-second');
    const speech = new BookDocumentOwner('holders', f.documents[0] as unknown as BookDoc);
    await f.init('holders-0', true);
    tts.held = true;
    await f.close();
    for (const doc of f.documents) expect(doc.destroy).not.toHaveBeenCalled();
    await f.close('holders-second');
    for (const doc of f.documents) expect(doc.destroy).not.toHaveBeenCalled();
    tts.held = false;
    await speech.close(async () => {});
    await releaseUnusedBookData('holders');
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 1]);
    expect(f.files.map(file => file.close.mock.calls.length)).toEqual([1, 1]);
  });

  test('failed reload cleans only its unpublished source and preserves the old generation', async () => {
    const f = lifecycleFixture('failedreload');
    await f.init();
    f.open.mockRejectedValueOnce(new Error('bad PDF'));
    await expect(f.init('failedreload-0', true)).rejects.toThrow('bad PDF');
    expect(f.files[1]!.close).toHaveBeenCalledOnce();
    expect(f.documents[0]!.destroy).not.toHaveBeenCalled();
    await f.close();
    expect(f.documents[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.files[0]!.close).toHaveBeenCalledOnce();
  });

  test('a failed old destroy still waits for all generations and allows a fresh concurrent open', async () => {
    const f = lifecycleFixture('destroyfailure');
    await f.init();
    const renderer = createBookRendererLifetime('destroyfailure', f.documents[0] as unknown as BookDoc);
    await f.init('destroyfailure-0', true);
    const cleanup = deferred();
    f.documents[0]!.destroy.mockRejectedValueOnce(new Error('worker failed'));
    f.documents[1]!.destroy.mockReturnValueOnce(cleanup.promise);
    const oldCleanup = renderer.close(async () => {});
    const oldRejected = expect(oldCleanup).rejects.toThrow('release book');
    let closed = false;
    const closing = f.close().finally(() => { closed = true; });
    const rejected = expect(closing).rejects.toThrow('release book');
    await vi.waitFor(() => expect(f.documents[1]!.destroy).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    await f.init('destroyfailure-new');
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(f.documents[2]!.destroy).not.toHaveBeenCalled();
    cleanup.resolve();
    await Promise.all([rejected, oldRejected]);
    expect(f.files.slice(0, 2).map(file => file.close.mock.calls.length)).toEqual([1, 1]);
    await f.close('destroyfailure-new');
    expect(f.documents[2]!.destroy).toHaveBeenCalledOnce();
  });

  test('an older parallel view holds only its own generation while newer reloads are collected', async () => {
    const f = lifecycleFixture('parallelgenerations');
    await f.init();
    await f.init('parallelgenerations-other');
    await f.init('parallelgenerations-0', true);
    await f.init('parallelgenerations-0', true);
    await releaseUnusedBookData('parallelgenerations');
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([0, 1, 0]);
    await f.close('parallelgenerations-other');
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 1, 0]);
    await f.close();
  });

  test.each(['resolve', 'reject'] as const)('old renderer %s waits for late setup and teardown without retaining later generations', async outcome => {
    const id = `renderer${outcome}`;
    const f = lifecycleFixture(id);
    await f.init();
    const renderer = createBookRendererLifetime(id, f.documents[0] as unknown as BookDoc);
    const setup = deferred();
    const teardown = deferred();
    const opened = renderer.open(() => setup.promise);
    const openResult = outcome === 'reject' ? expect(opened).rejects.toThrow('render failed') : opened;
    await Promise.resolve();
    await f.init(`${id}-0`, true);
    let closed = false;
    const destroyRenderer = vi.fn(() => teardown.promise);
    const closing = renderer.close(destroyRenderer).then(() => { closed = true; });
    const closingAgain = renderer.close(destroyRenderer);
    const sweep = releaseUnusedBookData(id);
    await Promise.resolve();
    expect(f.documents[0]!.destroy).not.toHaveBeenCalled();
    expect(renderer.isActive()).toBe(false);
    if (outcome === 'resolve') setup.resolve(); else setup.reject(new Error('render failed'));
    await openResult;
    await vi.waitFor(() => expect(destroyRenderer).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(f.documents[0]!.destroy).not.toHaveBeenCalled();
    teardown.resolve();
    await Promise.all([closing, closingAgain, sweep]);
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 0]);
    expect(f.files.map(file => file.close.mock.calls.length)).toEqual([1, 0]);
    await f.close();
  });

  test('TTS moves to a fresh generation but an old in-flight read and shutdown retain their own resources', async () => {
    const f = lifecycleFixture('speechgenerations');
    await f.init();
    const speech = new BookDocumentOwner('speechgenerations', f.documents[0] as unknown as BookDoc);
    const read = deferred();
    const reading = speech.run(f.documents[0] as unknown as BookDoc, () => read.promise);
    await f.init('speechgenerations-0', true);
    speech.move(f.documents[1] as unknown as BookDoc);
    await releaseUnusedBookData('speechgenerations');
    expect(f.documents[0]!.destroy).not.toHaveBeenCalled();
    read.resolve();
    await reading;
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 0]);
    await f.init('speechgenerations-0', true);
    const teardown = deferred();
    const shutdown = vi.fn(() => teardown.promise);
    const stopping = speech.close(shutdown);
    const again = speech.close(shutdown);
    const sweep = releaseUnusedBookData('speechgenerations');
    await Promise.resolve();
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 0, 0]);
    await expect(speech.run(f.documents[1] as unknown as BookDoc, async () => {})).rejects.toThrow('closed');
    teardown.resolve();
    await Promise.all([stopping, again, sweep]);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 1, 0]);
    await f.close();
  });

  test('a delayed old renderer cannot publish into a reopened view before React cleanup runs', async () => {
    const f = lifecycleFixture('latemount');
    await f.init();
    const previousKey = useReaderStore.getState().getViewState('latemount-0')!.viewerKey;
    const renderer = createBookRendererLifetime('latemount', f.documents[0] as unknown as BookDoc,
      () => useReaderStore.getState().getViewState('latemount-0')?.viewerKey === previousKey);
    const setup = deferred();
    const publish = vi.fn();
    const opening = renderer.open(async () => {
      await setup.promise;
      if (renderer.isActive()) publish();
    });
    await Promise.resolve();
    // uniqueId is normally unique; use distinct keys for this race too.
    vi.mocked(uniqueId).mockReturnValueOnce('new-mount');
    await f.init('latemount-0', true);
    expect(f.documents[0]!.destroy).not.toHaveBeenCalled();
    setup.resolve();
    await opening;
    expect(publish).not.toHaveBeenCalled();
    await renderer.close(async () => {});
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 0]);
    await f.close();
  });

  test('a post-parse reload failure destroys the unpublished document, retaining the published one', async () => {
    const f = lifecycleFixture('configfailure');
    await f.init();
    f.service.loadBookConfig.mockRejectedValueOnce(new Error('config failed'));
    await expect(f.init('configfailure-0', true)).rejects.toThrow('config failed');
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([0, 1]);
    expect(f.files.map(file => file.close.mock.calls.length)).toEqual([0, 1]);
    await f.close();
    expect(f.documents.map(doc => doc.destroy.mock.calls.length)).toEqual([1, 1]);
    expect(f.files.map(file => file.close.mock.calls.length)).toEqual([1, 1]);
  });
});

describe('SOL-002 cancelled initialization close fence', () => {
  test('close also waits for delayed content delivery before parsing starts', async () => {
    const f = lifecycleFixture('contentdelay');
    const content = deferred<BookContent>();
    const file = Object.assign(new File(['pdf'], 'late.pdf'), { close: vi.fn(async () => {}) });
    f.service.loadBookContent.mockReturnValueOnce(content.promise);
    const rejected = expect(f.init()).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.service.loadBookContent).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    content.resolve({ book: { hash: 'contentdelay', format: 'PDF' } as Book, file });
    await Promise.all([rejected, closing]);
    expect(file.close).toHaveBeenCalledOnce();
    expect(f.documents[0]!.destroy).toHaveBeenCalledOnce();
  });

  test.each(['resolve', 'reject'] as const)('close waits for abort-ignoring parse %s and file cleanup', async outcome => {
    const id = `cancel${outcome}`;
    const f = lifecycleFixture(id);
    const parse = deferred<{ book: BookDoc }>();
    const destroy = deferred();
    const fileClose = deferred();
    const doc = { metadata: {}, rendition: {}, destroy: vi.fn(() => destroy.promise) };
    f.open.mockReturnValueOnce(parse.promise);
    const opening = f.init();
    const rejected = expect(opening).rejects.toThrow(outcome === 'resolve' ? 'cancelled' : 'parse failed');
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.files[0]!.close.mockReturnValueOnce(fileClose.promise);
    let closed = false;
    let closedAgain = false;
    const closing = f.close().then(() => { closed = true; });
    const again = f.close().then(() => { closedAgain = true; });
    // A macrotask proves close did not resolve merely because no BookData was published.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(closedAgain).toBe(false);
    if (outcome === 'resolve') {
      parse.resolve({ book: doc as unknown as BookDoc });
      await vi.waitFor(() => expect(doc.destroy).toHaveBeenCalledOnce());
      expect(closed).toBe(false);
      destroy.resolve();
    } else parse.reject(new Error('parse failed'));
    await vi.waitFor(() => expect(f.files[0]!.close).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    fileClose.resolve();
    await Promise.all([rejected, closing, again]);
    expect(closed).toBe(true);
    expect(closedAgain).toBe(true);
    expect(useReaderStore.getState().getViewState(`${id}-0`)).toBeNull();
    expect(useBookDataStore.getState().booksData[id]).toBeUndefined();
  });

  test('old close does not wait for a subsequent open of the same key', async () => {
    const f = lifecycleFixture('reopen');
    const oldParse = deferred<{ book: BookDoc }>();
    const newParse = deferred<{ book: BookDoc }>();
    const oldDoc = { metadata: {}, rendition: {}, destroy: vi.fn(async () => {}) };
    const newDoc = { metadata: {}, rendition: {}, destroy: vi.fn(async () => {}) };
    f.open.mockReturnValueOnce(oldParse.promise).mockReturnValueOnce(newParse.promise);
    const old = expect(f.init()).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    const closing = f.close();
    const reopened = f.init();
    oldParse.resolve({ book: oldDoc as unknown as BookDoc });
    await Promise.all([old, closing]);
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
    expect(oldDoc.destroy).toHaveBeenCalledOnce();
    expect(f.files[0]!.close).toHaveBeenCalledOnce();
    expect(f.files[1]!.close).not.toHaveBeenCalled();
    expect(useReaderStore.getState().getViewState('reopen-0')?.loading).toBe(true);
    newParse.resolve({ book: newDoc as unknown as BookDoc });
    await reopened;
    expect(newDoc.destroy).not.toHaveBeenCalled();
    await f.close();
    expect(newDoc.destroy).toHaveBeenCalledOnce();
  });

  test('closing a superseded queued reload waits for its older cancelled parse too', async () => {
    const f = lifecycleFixture('queued');
    const parse = deferred<{ book: BookDoc }>();
    const doc = { metadata: {}, rendition: {}, destroy: vi.fn(async () => {}) };
    f.open.mockReturnValueOnce(parse.promise);
    const first = expect(f.init()).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    const second = expect(f.init('queued-0', true)).rejects.toThrow('cancelled');
    let closed = false;
    const closing = f.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    parse.resolve({ book: doc as unknown as BookDoc });
    await Promise.all([first, second, closing]);
    expect(f.open).toHaveBeenCalledOnce();
    expect(doc.destroy).toHaveBeenCalledOnce();
    expect(f.files[0]!.close).toHaveBeenCalledOnce();
  });
});

/**
 * Helper to seed a minimal ViewState in the store for a given key.
 */
function seedViewState(key: string, overrides: Record<string, unknown> = {}) {
  useReaderStore.setState((state) => ({
    viewStates: {
      ...state.viewStates,
      [key]: {
        key,
        view: null,
        viewerKey: `${key}-viewer`,
        isPrimary: true,
        loading: false,
        inited: false,
        error: null,
        ribbonVisible: false,
        ttsEnabled: false,
        autoScrollEnabled: false,
        syncing: false,
        gridInsets: null,
        previewMode: false,
        viewSettings: null,
        ...overrides,
      },
    },
  }));
}

test('closes a newly opened source when document initialization fails', async () => {
  const error = new Error('offline');
  const file = Object.assign(new File(['epub'], 'book.epub'), { close: vi.fn(async () => {}) });
  const book = { hash: 'failed', format: 'EPUB' } as Book;
  const appService = {
    loadBookContent: vi.fn(async () => ({ book, file })),
    loadBookConfig: vi.fn(async () => ({ viewSettings: {}, booknotes: [] })),
    loadBookNav: vi.fn(async () => null),
  };
  vi.mocked(useLibraryStore.getState().getBookByHash).mockReturnValue(book);
  useSettingsStore.setState({ settings: { globalViewSettings: {} } as never });
  vi.mocked(DocumentLoader).mockImplementation(function MockDocumentLoader() {
    return { open: vi.fn(async () => { throw error; }) };
  } as never);
  await expect(useReaderStore.getState().initViewState(
    { getAppService: async () => appService } as never, 'failed', 'failed-0',
  )).rejects.toBe(error);
  expect(file.close).toHaveBeenCalledOnce();
});

test('closing during loading destroys the late document without recreating the view', async () => {
  useReaderStore.setState({ viewStates: {} });
  useBookDataStore.setState({ booksData: {} });
  let finish!: (value: { book: BookDoc }) => void;
  const pending = new Promise<{ book: BookDoc }>(resolve => { finish = resolve; });
  const file = Object.assign(new File(['pdf'], 'book.pdf'), { close: vi.fn(async () => {}) });
  const book = { hash: 'cancelled', format: 'PDF' } as Book;
  const bookDoc = { metadata: {}, rendition: {}, destroy: vi.fn(async () => {}) } as unknown as BookDoc;
  const appService = {
    loadBookContent: vi.fn(async () => ({ book, file })),
    loadBookConfig: vi.fn(async () => ({ viewSettings: {}, booknotes: [] })),
  };
  vi.mocked(useLibraryStore.getState().getBookByHash).mockReturnValue(book);
  useSettingsStore.setState({ settings: { globalViewSettings: {} } as never });
  const open = vi.fn(() => pending);
  vi.mocked(DocumentLoader).mockImplementation(function MockDocumentLoader() {
    return { open };
  } as never);
  const initializing = useReaderStore.getState().initViewState(
    { getAppService: async () => appService } as never, 'cancelled', 'cancelled-0',
  );
  const rejected = expect(initializing).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(open).toHaveBeenCalled());
  const signal = open.mock.calls[0] as unknown as [{ signal: AbortSignal }];
  useReaderStore.getState().clearViewState('cancelled-0');
  expect(signal[0].signal.aborted).toBe(true);
  finish({ book: bookDoc });
  await rejected;
  expect(bookDoc.destroy).toHaveBeenCalledOnce();
  expect(file.close).toHaveBeenCalledOnce();
  expect(useReaderStore.getState().viewStates['cancelled-0']).toBeUndefined();
  expect(useBookDataStore.getState().booksData['cancelled']).toBeUndefined();
});

test('parallel views share one newly loaded document', async () => {
  useReaderStore.setState({ viewStates: {} });
  useBookDataStore.setState({ booksData: {} });
  const file = new File(['pdf'], 'book.pdf');
  const book = { hash: 'parallel', title: 'Book', format: 'PDF' } as Book;
  const bookDoc = { metadata: { title: 'Book' }, rendition: {}, sections: [] } as unknown as BookDoc;
  const appService = {
    loadBookContent: vi.fn(async () => ({ book, file })),
    loadBookConfig: vi.fn(async () => ({ viewSettings: {}, booknotes: [] })),
  };
  vi.mocked(useLibraryStore.getState().getBookByHash).mockReturnValue(book);
  useSettingsStore.setState({ settings: { globalViewSettings: {} } as never });
  const open = vi.fn(async () => ({ book: bookDoc }));
  vi.mocked(DocumentLoader).mockImplementation(function MockDocumentLoader() {
    return { open };
  } as never);
  const envConfig = { getAppService: async () => appService } as never;
  await Promise.all([
    useReaderStore.getState().initViewState(envConfig, 'parallel', 'parallel-1'),
    useReaderStore.getState().initViewState(envConfig, 'parallel', 'parallel-2', false),
  ]);
  expect(open).toHaveBeenCalledOnce();
  expect(appService.loadBookContent).toHaveBeenCalledOnce();
  expect(useReaderStore.getState().viewStates['parallel-1']?.key).toBe('parallel-1');
  expect(useReaderStore.getState().viewStates['parallel-2']?.key).toBe('parallel-2');
  expect(useReaderStore.getState().viewStates['parallel-1']?.loading).toBe(false);
  expect(useReaderStore.getState().viewStates['parallel-2']?.loading).toBe(false);
});

describe('readerStore', () => {
  beforeEach(() => {
    useReaderStore.setState({
      viewStates: {},
      bookKeys: [],
      hoveredBookKey: null,
    });
    useBookDataStore.setState({ booksData: {} });
  });

  describe('initViewState', () => {
    test.each([false, true])('initializes content while avoiding whole-book nav scans online=%s', async (online) => {
      vi.mocked(computeBookNav).mockClear();
      vi.mocked(hydrateBookNav).mockClear();
      window.__MOKE_EMBEDDED = online;
      window.__MOKE_SOURCE_SERVER_URL = 'https://books.example';
      window.__MOKE_BOOK_ID = '42';
      let resolveContent!: (content: BookContent) => void;
      const contentPromise = new Promise<BookContent>((resolve) => {
        resolveContent = resolve;
      });
      const file = new File(['epub'], 'book.epub', { type: 'application/epub+zip' });
      const book: Book = {
        url: online ? 'https://books.example/api/book/42.epub' : undefined,
        hash: 'bookid',
        title: 'Book',
        author: 'Author',
        format: 'EPUB',
        createdAt: 1,
        updatedAt: 1,
      };
      const config = { viewSettings: {}, booknotes: [] } as unknown as BookConfig;
      const bookDoc = {
        metadata: { title: 'Book' },
        rendition: {},
        toc: [],
        sections: [],
      } as unknown as BookDoc;
      const cachedNav = { version: 3, toc: [], sections: {} };
      const appService = {
        loadBookContent: vi.fn(() => contentPromise),
        resolveNativeBookFilePath: vi.fn(async () => '/books/book.epub'),
        loadBookConfig: vi.fn(async () => config),
        loadBookNav: vi.fn(async () => cachedNav),
        saveBookNav: vi.fn(async () => undefined),
      };
      const envConfig = { getAppService: vi.fn(async () => appService) };

      vi.mocked(useLibraryStore.getState().getBookByHash).mockReturnValue(book);
      useSettingsStore.setState({ settings: { globalViewSettings: {} } as never });
      vi.mocked(DocumentLoader).mockImplementation(function MockDocumentLoader() {
        return { open: vi.fn(async () => ({ book: bookDoc })) };
      } as never);
      vi.mocked(isBookNavCacheCurrent).mockReturnValue(true);
      vi.mocked(computeBookNav).mockResolvedValue(cachedNav);

      const initPromise = useReaderStore
        .getState()
        .initViewState(envConfig as never, book.hash, `${book.hash}-0`);

      await vi.waitFor(() => expect(appService.loadBookContent).toHaveBeenCalledOnce());
      // Sidecar reads do not depend on the File bytes. Keeping them behind
      // loadBookContent/DocumentLoader serializes Tauri IPC on every Moke open.
      expect(appService.loadBookConfig).toHaveBeenCalledOnce();
      expect(appService.loadBookNav).toHaveBeenCalledOnce();

      resolveContent({ book, file, nativeFilePath: '/books/book.epub' });
      await initPromise;

      expect(appService.resolveNativeBookFilePath).not.toHaveBeenCalled();
      expect(DocumentLoader).toHaveBeenCalledWith(file, {
        nativeFilePath: '/books/book.epub',
      });
      if (online) {
        expect(computeBookNav).not.toHaveBeenCalled();
        expect(hydrateBookNav).not.toHaveBeenCalled();
      } else expect(hydrateBookNav).toHaveBeenCalledWith(bookDoc, cachedNav);
      expect(useReaderStore.getState().getViewState(`${book.hash}-0`)?.loading).toBe(false);
      // Persisting a performance-only nav cache must not delay book:opened or
      // the first restored page, but it still runs shortly afterward.
      expect(appService.saveBookNav).not.toHaveBeenCalled();
      const pageInfo = { current: 0, next: 1, total: 10 };
      useReaderStore
        .getState()
        .setProgress(
          `${book.hash}-0`,
          'epubcfi(/6/2)',
          { label: 'Chapter 1', href: 'chapter.xhtml' } as never,
          undefined,
          pageInfo,
          pageInfo,
          { section: 10, total: 100 },
          document.createRange(),
          0.1,
        );
      if (online) expect(appService.saveBookNav).not.toHaveBeenCalled();
      else await vi.waitFor(() => expect(appService.saveBookNav).toHaveBeenCalledWith(book, cachedNav));
      window.__MOKE_EMBEDDED = false;
    });
  });

  describe('initial state', () => {
    test('has empty viewStates and bookKeys', () => {
      const state = useReaderStore.getState();
      expect(state.viewStates).toEqual({});
      expect(state.bookKeys).toEqual([]);
      expect(state.hoveredBookKey).toBeNull();
    });
  });

  describe('setBookKeys', () => {
    test('sets bookKeys array', () => {
      useReaderStore.getState().setBookKeys(['book-1', 'book-2']);
      expect(useReaderStore.getState().bookKeys).toEqual(['book-1', 'book-2']);
    });

    test('replaces existing bookKeys', () => {
      useReaderStore.getState().setBookKeys(['a']);
      useReaderStore.getState().setBookKeys(['b', 'c']);
      expect(useReaderStore.getState().bookKeys).toEqual(['b', 'c']);
    });
  });

  describe('setHoveredBookKey', () => {
    test('sets hovered book key', () => {
      useReaderStore.getState().setHoveredBookKey('book-1');
      expect(useReaderStore.getState().hoveredBookKey).toBe('book-1');
    });

    test('can be set to null', () => {
      useReaderStore.getState().setHoveredBookKey('book-1');
      useReaderStore.getState().setHoveredBookKey(null);
      expect(useReaderStore.getState().hoveredBookKey).toBeNull();
    });
  });

  describe('getView / setView', () => {
    test('getView returns null for missing key', () => {
      expect(useReaderStore.getState().getView('nonexistent')).toBeNull();
    });

    test('getView returns null for null key', () => {
      expect(useReaderStore.getState().getView(null)).toBeNull();
    });

    test('setView stores a view and getView retrieves it', () => {
      const key = 'abc-0';
      seedViewState(key);

      const mockView = { tagName: 'FOLIATE-VIEW' } as unknown as FoliateView;
      useReaderStore.getState().setView(key, mockView);

      const retrieved = useReaderStore.getState().getView(key);
      expect(retrieved).toBe(mockView);
    });
  });

  describe('getViews', () => {
    test('returns all views from viewStates', () => {
      const view1 = { id: 'v1' } as unknown as FoliateView;
      const view2 = { id: 'v2' } as unknown as FoliateView;
      seedViewState('key1', { view: view1 });
      seedViewState('key2', { view: view2 });

      const views = useReaderStore.getState().getViews();
      expect(views).toHaveLength(2);
      expect(views).toContain(view1);
      expect(views).toContain(view2);
    });
  });

  describe('clearViewState', () => {
    test('removes a view state by key', () => {
      seedViewState('key-to-remove');
      seedViewState('key-to-keep');

      useReaderStore.getState().clearViewState('key-to-remove');
      const state = useReaderStore.getState();
      expect(state.viewStates['key-to-remove']).toBeUndefined();
      expect(state.viewStates['key-to-keep']).toBeDefined();
    });

    test('does nothing when key does not exist', () => {
      seedViewState('existing');
      useReaderStore.getState().clearViewState('nonexistent');
      expect(useReaderStore.getState().viewStates['existing']).toBeDefined();
    });
  });

  describe('getViewState', () => {
    test('returns null for missing key', () => {
      expect(useReaderStore.getState().getViewState('missing')).toBeNull();
    });

    test('returns the view state for existing key', () => {
      seedViewState('my-key');
      const vs = useReaderStore.getState().getViewState('my-key');
      expect(vs).not.toBeNull();
      expect(vs!.key).toBe('my-key');
    });
  });

  describe('setViewSettings / getViewSettings', () => {
    test('getViewSettings returns null for missing key', () => {
      expect(useReaderStore.getState().getViewSettings('missing')).toBeNull();
    });

    test('setViewSettings stores and getViewSettings retrieves settings', () => {
      const key = 'bookid-0';
      seedViewState(key, { isPrimary: false });

      // setViewSettings requires bookData to exist for the book id
      useBookDataStore.setState({
        booksData: {
          bookid: {
            id: 'bookid',
            book: null,
            file: null,
            config: { updatedAt: Date.now() },
            bookDoc: null,
            isFixedLayout: false,
          },
        },
      });

      const settings = { fontSize: 16 } as unknown as ViewSettings;
      useReaderStore.getState().setViewSettings(key, settings);

      const retrieved = useReaderStore.getState().getViewSettings(key);
      expect(retrieved).toEqual(settings);
    });

    test('setViewSettings does nothing for empty key', () => {
      useReaderStore.getState().setViewSettings('', { fontSize: 16 } as unknown as ViewSettings);
      // Should not throw or create new state
      expect(Object.keys(useReaderStore.getState().viewStates)).toHaveLength(0);
    });
  });

  describe('setBookmarkRibbonVisibility', () => {
    test('sets ribbonVisible on view state', () => {
      seedViewState('book-1');
      useReaderStore.getState().setBookmarkRibbonVisibility('book-1', true);
      expect(useReaderStore.getState().viewStates['book-1']!.ribbonVisible).toBe(true);

      useReaderStore.getState().setBookmarkRibbonVisibility('book-1', false);
      expect(useReaderStore.getState().viewStates['book-1']!.ribbonVisible).toBe(false);
    });
  });

  describe('setTTSEnabled', () => {
    test('sets ttsEnabled on view state', () => {
      seedViewState('book-1');
      useReaderStore.getState().setTTSEnabled('book-1', true);
      expect(useReaderStore.getState().viewStates['book-1']!.ttsEnabled).toBe(true);

      useReaderStore.getState().setTTSEnabled('book-1', false);
      expect(useReaderStore.getState().viewStates['book-1']!.ttsEnabled).toBe(false);
    });
  });

  describe('setIsLoading', () => {
    test('sets loading on view state', () => {
      seedViewState('book-1');
      useReaderStore.getState().setIsLoading('book-1', true);
      expect(useReaderStore.getState().viewStates['book-1']!.loading).toBe(true);

      useReaderStore.getState().setIsLoading('book-1', false);
      expect(useReaderStore.getState().viewStates['book-1']!.loading).toBe(false);
    });
  });

  describe('setIsSyncing', () => {
    test('sets syncing on view state', () => {
      seedViewState('book-1');
      useReaderStore.getState().setIsSyncing('book-1', true);
      expect(useReaderStore.getState().viewStates['book-1']!.syncing).toBe(true);

      useReaderStore.getState().setIsSyncing('book-1', false);
      expect(useReaderStore.getState().viewStates['book-1']!.syncing).toBe(false);
    });
  });

  describe('getGridInsets / setGridInsets', () => {
    test('getGridInsets returns default insets for missing key', () => {
      const insets = useReaderStore.getState().getGridInsets('missing');
      expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    test('setGridInsets stores and getGridInsets retrieves insets', () => {
      seedViewState('book-1');
      const insets: Insets = { top: 10, right: 5, bottom: 20, left: 5 };
      useReaderStore.getState().setGridInsets('book-1', insets);
      expect(useReaderStore.getState().getGridInsets('book-1')).toEqual(insets);
    });

    test('setGridInsets can set null', () => {
      seedViewState('book-1');
      useReaderStore.getState().setGridInsets('book-1', { top: 1, right: 2, bottom: 3, left: 4 });
      useReaderStore.getState().setGridInsets('book-1', null);
      // getGridInsets falls back to default when gridInsets is null
      expect(useReaderStore.getState().getGridInsets('book-1')).toEqual({
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      });
    });
  });

  describe('setViewInited', () => {
    test('sets inited on view state', () => {
      seedViewState('book-1');
      useReaderStore.getState().setViewInited('book-1', true);
      expect(useReaderStore.getState().viewStates['book-1']!.inited).toBe(true);

      useReaderStore.getState().setViewInited('book-1', false);
      expect(useReaderStore.getState().viewStates['book-1']!.inited).toBe(false);
    });
  });

  describe('recreateViewer', () => {
    // Regression test for #5277: `initViewState` already mints a fresh
    // viewerKey, so minting a second one here remounted <FoliateViewer> twice.
    // The abandoned first mount kept opening the same bookDoc and left an extra
    // `data` transform listener on its shared loader, so every stylesheet was
    // transformed twice and the book's fonts were replaced by the app's.
    test('mints a single viewerKey so the viewer mounts only once', async () => {
      seedViewState('book-1', { viewerKey: 'book-1-uid-0' });

      let counter = 0;
      const uniqueIdMock = vi.mocked(uniqueId);
      uniqueIdMock.mockImplementation(() => `uid-${++counter}`);

      // Stand in for the real initViewState, which reloads the book and ends by
      // assigning a fresh viewerKey of its own.
      const initViewState = vi.fn(async (_envConfig: unknown, _id: string, key: string) => {
        useReaderStore.setState((state) => ({
          viewStates: {
            ...state.viewStates,
            [key]: { ...state.viewStates[key]!, viewerKey: `${key}-${uniqueId()}` },
          },
        }));
      });
      useReaderStore.setState({
        initViewState: initViewState as unknown as ReturnType<
          typeof useReaderStore.getState
        >['initViewState'],
      });

      const mountedKeys: string[] = [];
      const unsubscribe = useReaderStore.subscribe((state) => {
        const viewerKey = state.viewStates['book-1']?.viewerKey;
        if (viewerKey && mountedKeys.at(-1) !== viewerKey) mountedKeys.push(viewerKey);
      });

      useReaderStore.getState().recreateViewer({} as never, 'book-1');
      await vi.waitFor(() => expect(initViewState).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      unsubscribe();

      expect(mountedKeys).toEqual(['book-1-uid-1']);
      uniqueIdMock.mockImplementation(() => 'mock-uid-123');
    });
  });
});
