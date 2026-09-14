import { expect, it } from 'vitest';
import type { TOCItem } from '@/libs/document';
import { getInitialReaderLocation } from '@/app/reader/utils/transientReader';

const chapter = { id: 1, index: 0, label: 'Chapter One', href: 'chapter.xhtml#one' };
const toc: TOCItem[] = [{ ...chapter, href: '', subitems: [chapter] }];

it('opens the first navigable TOC entry on an online cold open', () => {
  expect(getInitialReaderLocation(undefined, true, toc)).toBe(chapter.href);
});

it('keeps saved positions and explicit deep links ahead of the TOC', () => {
  expect(getInitialReaderLocation('epubcfi(/6/2!/4)', true, toc)).toBe('epubcfi(/6/2!/4)');
});

it('preserves first-page navigation for offline books and books without a TOC', () => {
  expect(getInitialReaderLocation(undefined, false, toc)).toBeUndefined();
  expect(getInitialReaderLocation(undefined, true, [])).toBeUndefined();
});
