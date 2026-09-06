import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));

import { invoke } from '@tauri-apps/api/core';
import { tryNativeParseEpub, tryNativePrefetchEpub } from '@/utils/tauriEpubBridge';
import { isEligibleMobiPath } from '@/utils/tauriMobiBridge';

describe('native book parser filesystem boundary', () => {
  it.each([
    'https://books.example/api/book/11.epub',
    'HTTP://books.example/book.epub',
    'blob:https://books.example/book.epub',
    'content://provider/book.epub',
    'file:///books/book.epub',
    'asset://localhost/book.epub',
  ])('does not invoke native parsers for %s', async (url) => {
    vi.mocked(invoke).mockClear();
    expect(await tryNativeParseEpub(url)).toBeNull();
    expect(await tryNativePrefetchEpub(url)).toBeNull();
    expect(isEligibleMobiPath(url.replace(/\.epub$/i, '.mobi'))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    '/books/book.epub',
    'C:\\books\\book.epub',
    'C:/books/book.epub',
    '\\\\server\\share\\book.epub',
    'book.epub',
  ])('retains native fast paths for %s', async (path) => {
    vi.mocked(invoke).mockClear();
    await tryNativeParseEpub(path);
    await tryNativePrefetchEpub(path);
    expect(invoke).toHaveBeenCalledWith('parse_epub_metadata', { filePath: path });
    expect(invoke).toHaveBeenCalledWith('parse_epub_full', { filePath: path });
    expect(isEligibleMobiPath(path.replace('.epub', '.mobi'))).toBe(true);
  });
});
