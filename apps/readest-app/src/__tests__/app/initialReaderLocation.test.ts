import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MokeHostLaunch } from '@/services/mokeHostLaunch';
import { claimFixture } from '../helpers/hostLaunchFixture';
import type { TOCItem } from '@/libs/document';
import { getInitialReaderLocation } from '@/app/reader/utils/transientReader';

const chapter = { id: 1, index: 0, label: 'Chapter One', href: 'chapter.xhtml#one' };
const toc: TOCItem[] = [{ ...chapter, href: '', subitems: [chapter] }];
const book = { url: 'https://books.example/api/book/42.epub' };
const fixture = vi.hoisted(() => ({ launch: null as MokeHostLaunch | null }));
vi.mock('@/services/mokeHostLaunch', async (original) => ({
  ...(await original<typeof import('@/services/mokeHostLaunch')>()),
  getMokeHostLaunch: () => fixture.launch,
}));

beforeEach(() => {
  const claim = claimFixture('https://books.example');
  fixture.launch = new MokeHostLaunch(
    { ...claim, resource: { ...claim.resource, url: book.url, revision: null } },
    vi.fn(),
    vi.fn(),
  );
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_SOURCE_SERVER_URL = 'https://books.example';
  window.__MOKE_BOOK_ID = '42';
});
afterEach(() => {
  fixture.launch = null;
  window.__MOKE_EMBEDDED = false;
  window.__MOKE_SOURCE_SERVER_URL = null;
  window.__MOKE_BOOK_ID = null;
});

it('opens the first navigable TOC entry on an online cold open', () => {
  expect(getInitialReaderLocation(undefined, book, toc)).toBe(chapter.href);
});

it('keeps saved positions and explicit deep links ahead of the TOC', () => {
  expect(getInitialReaderLocation('epubcfi(/6/2!/4)', book, toc)).toBe('epubcfi(/6/2!/4)');
});

it('preserves first-page navigation for offline books and books without a TOC', () => {
  expect(
    getInitialReaderLocation(undefined, { filePath: '/Books/book.epub' }, toc),
  ).toBeUndefined();
  expect(getInitialReaderLocation(undefined, book, [])).toBeUndefined();
});
