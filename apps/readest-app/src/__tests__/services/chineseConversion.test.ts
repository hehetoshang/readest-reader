import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookDoc } from '@/libs/document';
import type { ConvertChineseVariant, ViewSettings } from '@/types/book';
import type { TransformContext } from '@/services/transformers/types';

const WASM_PATH = '/readest/vendor/simplecc/simplecc_wasm_bg.wasm';
const wasmFile = resolve(
  process.cwd(),
  '../../vendor/simplecc-wasm/dist/web/simplecc_wasm_bg.wasm',
);

const fetchAsset = vi.fn(async (input: RequestInfo | URL) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path !== WASM_PATH) throw new Error(`Missing embedded Reader asset: ${path}`);
  const bytes = await readFile(wasmFile);
  return new Response(Uint8Array.from(bytes), {
    headers: { 'Content-Type': 'application/wasm' },
  });
});

const makeBookDoc = (): BookDoc => ({
  metadata: { title: '繁體書籍', author: '', language: 'zh-Hant' },
  rendition: { layout: 'reflowable' },
  dir: 'ltr',
  toc: [
    {
      id: 1,
      index: 0,
      label: '繁體書籍',
      href: '繁體.xhtml',
      subitems: [{ id: 2, index: 0, label: '發財了去植髮', href: '繁體.xhtml#章節' }],
    },
  ],
  sections: [],
  splitTOCHref: (href) => href.split('#'),
  getCover: async () => null,
});

const makeContext = (
  content: string,
  convertChineseVariant: ConvertChineseVariant,
): TransformContext => ({
  bookKey: 'traditional-book',
  viewSettings: { convertChineseVariant } as ViewSettings,
  userLocale: 'zh-CN',
  isFixedLayout: false,
  contentType: 'application/xhtml+xml',
  content,
  transformers: ['simplecc'],
});

beforeEach(() => {
  vi.resetModules();
  fetchAsset.mockClear();
  vi.stubEnv('NEXT_PUBLIC_EMBEDDED_BASE_PATH', '/readest');
  vi.stubGlobal('fetch', fetchAsset);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('embedded Reader Chinese conversion', () => {
  it('loads the embedded WASM and converts nested TOC labels and chapter text', async () => {
    const { updateToc } = await import('@/services/nav');
    const { simpleccTransformer } = await import('@/services/transformers/simplecc');
    const bookDoc = makeBookDoc();

    await updateToc(bookDoc, false, 't2s');
    expect(bookDoc.toc?.[0]?.label).toBe('繁体书籍');
    expect(bookDoc.toc?.[0]?.subitems?.[0]?.label).toBe('发财了去植发');
    expect(bookDoc.toc?.[0]?.href).toBe('繁體.xhtml');
    expect(bookDoc.toc?.[0]?.subitems?.[0]?.href).toBe('繁體.xhtml#章節');

    const content = `<!DOCTYPE html>
      <html xmlns="http://www.w3.org/1999/xhtml" lang="zh-Hant">
        <head><title>繁體書籍</title><style>.繁體 { color: red; }</style></head>
        <body>
          <p id="章節" data-title="繁體">繁體中文，<em>發財了去植髮</em>。<a href="繁體.xhtml#章節">讀書</a></p>
          <script>const label = "繁體";</script>
        </body>
      </html>`;
    const converted = await simpleccTransformer.transform(makeContext(content, 't2s'));
    // Inspect the chapter DOM as HTML: jsdom's XMLSerializer duplicates an
    // explicit XHTML xmlns attribute, whereas Chromium serializes it once.
    const doc = new DOMParser().parseFromString(converted, 'text/html');

    expect(doc.documentElement.getAttribute('lang')).toBe('zh-Hant');
    const paragraph = doc.querySelector('p');
    expect(paragraph?.textContent).toBe('繁体中文，发财了去植发。读书');
    expect(paragraph?.getAttribute('id')).toBe('章節');
    expect(paragraph?.getAttribute('data-title')).toBe('繁體');
    expect(paragraph?.querySelector('em')?.textContent).toBe('发财了去植发');
    expect(paragraph?.querySelector('a')?.getAttribute('href')).toBe('繁體.xhtml#章節');
    expect(doc.querySelector('style')?.textContent).toBe('.繁體 { color: red; }');
    expect(doc.querySelector('script')?.textContent).toBe('const label = "繁體";');
    expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(WASM_PATH);
  });

  it('keeps conversion disabled without loading WASM', async () => {
    const { updateToc } = await import('@/services/nav');
    const { simpleccTransformer } = await import('@/services/transformers/simplecc');
    const bookDoc = makeBookDoc();
    const content = '<p id="章節">繁體書籍</p>';

    await updateToc(bookDoc, false, 'none');
    await expect(simpleccTransformer.transform(makeContext(content, 'none'))).resolves.toBe(
      content,
    );

    expect(bookDoc.toc?.[0]?.label).toBe('繁體書籍');
    expect(bookDoc.toc?.[0]?.subitems?.[0]?.label).toBe('發財了去植髮');
    expect(fetchAsset).not.toHaveBeenCalled();
  });
});
