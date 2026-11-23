import { beforeEach, expect, it, vi } from 'vitest';
import { File as NodeFile } from 'node:buffer';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { FileSystem } from '@/types/system';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: vi.fn() }));

const SCHEMA = 'moke.readest.downloaded-book-identity.v1';
const URL = '/readest/reader?moke=1&mokeDownloadIdentityId=fixture-claim';
const MOBI = '/fixture/one.mobi';
const AZW = '/fixture/two.azw';
const CONTENT_HASH = 'same-content-hash';
const inherited = {
  location: 'anonymous-location',
  booknotes: [{ id: 'anonymous-note', cfi: 'anonymous-location' }],
  viewSettings: { fontSize: 25 },
};

beforeEach(() => {
  invoke.mockReset();
  vi.resetModules();
  window.history.replaceState(null, '', URL);
  window.OPEN_WITH_FILES = null;
});

it('accepts only the caller-bound reply and invalidates its path at document teardown', async () => {
  const reply = { schema: SCHEMA, sourcePath: 'C:\\downloads\\fixture.azw', identityKey: 'key' };
  invoke.mockResolvedValue(reply);
  const identity = await import('@/services/mokeDownloadedBookIdentity');
  await Promise.all([
    identity.bootstrapMokeDownloadedBookIdentity(),
    identity.bootstrapMokeDownloadedBookIdentity(),
  ]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('moke_reader_claim_downloaded_book_identity', {
    launchId: 'fixture-claim',
  });
  expect(window.OPEN_WITH_FILES).toEqual([reply.sourcePath]);
  expect(identity.downloadedBookIdentityForPath(reply.sourcePath)).toContain('key');
  expect(() => identity.downloadedBookIdentityForPath(MOBI)).toThrow('reader_invalid_launch');
  window.dispatchEvent(new Event('pagehide'));
  expect(() => identity.downloadedBookIdentityForPath(reply.sourcePath)).toThrow(
    'reader_invalid_launch',
  );
});

it.each([
  '&file=/fixture/book.mobi',
  '&identityKey=other',
  '&mokeLaunchId=epub',
  '&cfi=old',
  '&mokeDownloadIdentityId=second',
])('rejects a mixed or duplicate URL parameter before native invocation (%s)', async (extra) => {
  window.history.replaceState(null, '', URL + extra);
  const { bootstrapMokeDownloadedBookIdentity } = await import(
    '@/services/mokeDownloadedBookIdentity'
  );
  await expect(bootstrapMokeDownloadedBookIdentity()).rejects.toThrow('reader_invalid_launch');
  expect(invoke).not.toHaveBeenCalled();
  expect(window.OPEN_WITH_FILES).toBeNull();
});

it.each([
  'https://example.test/book.mobi',
  'relative.mobi',
  '//example.test/book.mobi',
])('rejects a non-native path before handing off a file (%s)', async (sourcePath) => {
  invoke.mockResolvedValue({ schema: SCHEMA, sourcePath, identityKey: 'key' });
  const { bootstrapMokeDownloadedBookIdentity } = await import(
    '@/services/mokeDownloadedBookIdentity'
  );
  await expect(bootstrapMokeDownloadedBookIdentity()).rejects.toThrow('reader_invalid_launch');
  expect(window.OPEN_WITH_FILES).toBeNull();
});

it('publishes no path when native has rejected the reservation or the reply arrives after pagehide', async () => {
  const open = async () =>
    (await import('@/services/mokeDownloadedBookIdentity')).bootstrapMokeDownloadedBookIdentity();
  invoke.mockRejectedValueOnce(new Error('reader_invalid_launch'));
  await expect(open()).rejects.toThrow('reader_invalid_launch');
  expect(window.OPEN_WITH_FILES).toBeNull();

  vi.resetModules();
  invoke.mockImplementationOnce(async () => {
    window.dispatchEvent(new Event('pagehide'));
    return { schema: SCHEMA, sourcePath: MOBI, identityKey: 'key' };
  });
  await expect(open()).rejects.toThrow('reader_invalid_launch');
  expect(window.OPEN_WITH_FILES).toBeNull();
});

it('isolates saved config by native entry and validates the path, identity and scoped hash before I/O', async () => {
  const anonymousPath = `${CONTENT_HASH}/config.json`;
  const configs = new Map([[anonymousPath, JSON.stringify(inherited)]]);
  const fs = {
    exists: vi.fn(async (path: string) => configs.has(path)),
    readFile: vi.fn(async (path: string) => configs.get(path)),
    writeFile: vi.fn(async (path: string, _base: string, data: string) => configs.set(path, data)),
    openFile: vi.fn(),
  };
  const settings = { globalViewSettings: {} } as SystemSettings;
  const open = async (sourcePath: string, key: unknown[]) => {
    window.dispatchEvent(new Event('pagehide'));
    vi.resetModules();
    invoke.mockResolvedValue({ schema: SCHEMA, sourcePath, identityKey: JSON.stringify(key) });
    const { bootstrapMokeDownloadedBookIdentity } = await import(
      '@/services/mokeDownloadedBookIdentity'
    );
    const { managedBookFields } = await import('@/services/mokeProgressIdentity');
    const service = await import('@/services/bookService');
    await bootstrapMokeDownloadedBookIdentity();
    // Both file extensions can yield the same format and hash from the parser.
    const book = {
      ...managedBookFields(sourcePath, CONTENT_HASH),
      filePath: sourcePath,
      format: 'MOBI',
    } as Book;
    const fileSystem = fs as unknown as FileSystem;
    return {
      book,
      load: (other: Book = book) => service.loadBookConfig(fileSystem, other, settings),
      content: (other: Book = book) => service.loadBookContent(fileSystem, other),
      save: (location: string, other: Book = book) =>
        service.saveBookConfig(fileSystem, other, { updatedAt: 1, location }),
    };
  };

  const mobi = ['https://books.example/a', 'account-a', '42', 'mobi', 'v1'];
  const azw = ['https://books.example/a', 'account-a', '42', 'azw', 'v1'];
  const first = await open(MOBI, mobi);
  expect(await first.load()).toMatchObject({ viewSettings: { fontSize: 25 } });
  expect((await first.load()).location).toBeUndefined();
  expect((await first.load()).booknotes).toBeUndefined();
  await first.save('mobi-location');
  const second = await open(AZW, azw);
  expect(second.book.hash).not.toBe(first.book.hash);
  expect((await second.load()).location).toBeUndefined();
  await second.save('azw-location');

  for (const wrong of [
    first.book,
    { ...second.book, filePath: MOBI },
    { ...second.book, hash: CONTENT_HASH },
    { ...second.book, mokeIdentity: undefined },
  ]) {
    const calls = fs.exists.mock.calls.length;
    await expect(second.load(wrong)).rejects.toThrow('reader_invalid_launch');
    await expect(second.save('wrong', wrong)).rejects.toThrow('reader_invalid_launch');
    await expect(second.content(wrong)).rejects.toThrow('reader_invalid_launch');
    expect(fs.exists).toHaveBeenCalledTimes(calls);
  }
  expect(fs.writeFile).toHaveBeenCalledTimes(2);
  expect(fs.openFile).not.toHaveBeenCalled();
  const file = new File(['same bytes'], 'two.azw');
  fs.openFile.mockResolvedValueOnce(file);
  await expect(second.content()).resolves.toMatchObject({ file, book: second.book });
  expect(fs.openFile).toHaveBeenCalledExactlyOnceWith(AZW, 'None');

  expect((await (await open(MOBI, mobi)).load()).location).toBe('mobi-location');
  expect((await (await open(AZW, azw)).load()).location).toBe('azw-location');
  for (const changed of [
    ['https://books.example/b', ...mobi.slice(1)],
    [mobi[0], 'account-b', ...mobi.slice(2)],
    [...mobi.slice(0, 2), '43', ...mobi.slice(3)],
    [...mobi.slice(0, -1), 'v2'],
  ]) {
    expect((await (await open(MOBI, changed)).load()).location).toBeUndefined();
  }
  expect(configs.get(anonymousPath)).toBe(JSON.stringify(inherited));

  window.history.replaceState(null, '', '/readest/reader');
  vi.resetModules();
  const { managedBookFields } = await import('@/services/mokeProgressIdentity');
  expect(managedBookFields(MOBI, CONTENT_HASH)).toEqual({ hash: CONTENT_HASH });
  expect(managedBookFields(AZW, CONTENT_HASH)).toEqual({ hash: CONTENT_HASH });
});

it('binds the transient book before its first config write and preserves ordinary import dedupe', async () => {
  vi.doMock('@/libs/document', async (original) => ({
    ...(await original<object>()),
    DocumentLoader: class {
      async open() {
        return {
          book: { metadata: { title: 'Synthetic book', language: 'en' } },
          format: 'MOBI',
        };
      }
    },
  }));
  const configs = new Map<string, string>();
  const mobiFile = new NodeFile(['same bytes'], 'one.mobi');
  const azwFile = new NodeFile(['same bytes'], 'two.azw');
  const fs = {
    createDir: vi.fn(),
    openFile: vi.fn(async () => mobiFile),
    exists: vi.fn(async (path: string) => configs.has(path)),
    readFile: vi.fn(async (path: string) => configs.get(path)),
    writeFile: vi.fn(async (path: string, _base: string, data: string) => configs.set(path, data)),
  } as unknown as FileSystem;
  const options = {
    saveBook: false,
    saveCover: false,
    generateCoverImageUrl: vi.fn(async () => ''),
  };
  try {
    invoke.mockResolvedValue({ schema: SCHEMA, sourcePath: MOBI, identityKey: 'key' });
    const identity = await import('@/services/mokeDownloadedBookIdentity');
    await identity.bootstrapMokeDownloadedBookIdentity();
    const scoped = await import('@/services/bookService');
    const saveBookConfig = vi.fn((book, config) => scoped.saveBookConfig(fs, book, config));
    await expect(
      scoped.importBook(fs, AZW, [], { ...options, transient: true, saveBookConfig }),
    ).rejects.toThrow('reader_invalid_launch');
    expect(fs.openFile).not.toHaveBeenCalled();
    const book = await scoped.importBook(fs, MOBI, [], {
      ...options,
      transient: true,
      saveBookConfig,
    });
    expect(saveBookConfig).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ filePath: MOBI, hash: book?.hash }),
      expect.any(Object),
    );
    expect(configs.get(`${book?.hash}/config.json`)).toBeDefined();

    window.dispatchEvent(new Event('pagehide'));
    window.history.replaceState(null, '', '/readest/reader');
    vi.resetModules();
    const ordinary = await import('@/services/bookService');
    const library: Book[] = [];
    const ordinaryOptions = {
      ...options,
      saveBookConfig: (book: Book, config: Parameters<typeof ordinary.saveBookConfig>[2]) =>
        ordinary.saveBookConfig(fs, book, config),
    };
    const one = await ordinary.importBook(fs, mobiFile as File, library, ordinaryOptions);
    const two = await ordinary.importBook(fs, azwFile as File, library, ordinaryOptions);
    expect(one?.hash).toBe(two?.hash);
    expect(one?.hash).not.toBe(book?.hash);
    expect(library).toHaveLength(1);
  } finally {
    vi.doUnmock('@/libs/document');
  }
});
