import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
const { zipSync } = createRequire(import.meta.url)('fflate') as typeof import('fflate');
import { DocumentLoader } from '@/libs/document';
import { RemoteFile } from '@/utils/file';
import {
  createMokeRemoteSourceTransport,
  MokeRemoteSourceError,
  mokeRemoteSourceErrorDetail,
} from '@/services/mokeRemoteSource';

const SERVER = 'https://books.example';
const SOURCE = `${SERVER}/api/book/42.epub`;

function fixture(ncx: boolean) {
  // fflate can live in Node's realm while Vitest uses jsdom's typed arrays.
  const ZipBytes = zipSync({}).constructor as Uint8ArrayConstructor;
  const text = (value: string) => new ZipBytes(Buffer.from(value));
  return zipSync(
    {
      mimetype: text('application/epub+zip'),
      'META-INF/container.xml': text(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'OEBPS/book.opf': text(
        `<package xmlns="http://www.idpf.org/2007/opf" version="${ncx ? '2.0' : '3.0'}" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>Range test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="${ncx ? 'toc.ncx' : 'nav.xhtml'}" media-type="${ncx ? 'application/x-dtbncx+xml' : 'application/xhtml+xml'}" ${ncx ? '' : 'properties="nav"'}/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="nav"><itemref idref="one"/><itemref idref="two"/></spine></package>`,
      ),
      'padding-before-nav': new ZipBytes(256 * 1024),
      [ncx ? 'OEBPS/toc.ncx' : 'OEBPS/nav.xhtml']: text(
        ncx
          ? '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one"><navLabel><text>Chapter One</text></navLabel><content src="one.xhtml#one"/><navPoint id="two"><navLabel><text>Chapter Two</text></navLabel><content src="two.xhtml#two"/></navPoint></navPoint></navMap></ncx>'
          : '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="one.xhtml#one">Chapter One</a><ol><li><a href="two.xhtml#two">Chapter Two</a></li></ol></li></ol></nav></body></html>',
      ),
      'padding-before-chapters': new ZipBytes(256 * 1024),
      'OEBPS/one.xhtml': text(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="one">First chapter content</h1></body></html>',
      ),
      'OEBPS/two.xhtml': text(
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="two">Second chapter content</h1></body></html>',
      ),
      'unread-media': new ZipBytes(2 * 1024 * 1024),
    },
    { level: 0 },
  );
}

function server(bytes: Uint8Array, fail?: (start: number, end: number) => boolean) {
  const reads: Array<[number, number]> = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    let result: Response;
    const headers = { 'content-type': 'application/epub+zip', etag: '"stable"' };
    if (init?.method === 'HEAD')
      result = new Response(null, {
        headers: { ...headers, 'content-length': String(bytes.length) },
      });
    else {
      const match = new Headers(init?.headers).get('range')!.match(/^bytes=(\d+)-(\d+)$/)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      reads.push([start, end]);
      if (fail?.(start, end)) result = new Response(null, { status: 503 });
      else
        result = new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            ...headers,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
          },
        });
    }
    Object.defineProperty(result, 'url', { value: SOURCE });
    return result;
  });
  return { fetch, reads };
}

beforeEach(() => {
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_SOURCE_SERVER_URL = `${SERVER}:443`;
  window.__MOKE_BOOK_ID = '42';
});
afterEach(() => {
  window.__MOKE_EMBEDDED = false;
  vi.useRealTimers();
});

describe('real ZIP / EPUB parser over the online Range transport', () => {
  it.each([
    false,
    true,
  ])('loads nested %s directory and both chapter targets with bounded traffic', async (ncx) => {
    const bytes = fixture(ncx);
    let failures = 0;
    const endpoint = server(bytes, () => ++failures === 2);
    const http = createServer(async (request, response) => {
      const result = await endpoint.fetch(SOURCE, {
        method: request.method,
        headers: request.headers as Record<string, string>,
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(new Uint8Array(await result.arrayBuffer()));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const source = `${origin}/api/book/42.epub`;
    window.__MOKE_SOURCE_SERVER_URL = origin;
    let file: RemoteFile | undefined;
    try {
      file = await new RemoteFile(
        source,
        'book.epub',
        '',
        Date.now(),
        createMokeRemoteSourceTransport(source, (url, init) => globalThis.fetch(url, init))!,
      ).open();

      const { book } = await new DocumentLoader(file).open();
      expect(book.toc?.[0]?.label).toBe('Chapter One');
      expect(book.toc?.[0]?.subitems?.[0]?.label).toBe('Chapter Two');
      const epub = book as typeof book & { resolveHref(href: string): { index: number } };
      expect(epub.resolveHref(book.toc![0]!.href).index).toBe(0);
      expect(epub.resolveHref(book.toc![0]!.subitems![0]!.href).index).toBe(1);
      expect(await book.sections[0]!.loadText!()).toContain('First chapter content');
      expect(await book.sections[1]!.loadText!()).toContain('Second chapter content');
      const requests = endpoint.reads.length;
      await book.sections[1]!.loadText!();
      expect(endpoint.reads).toHaveLength(requests);
      const transferred = endpoint.reads.reduce((sum, [start, end]) => sum + end - start + 1, 0);
      expect(transferred).toBeLessThan(bytes.length / 5);
      expect(endpoint.reads.some(([, end]) => end === bytes.length - 1)).toBe(true);
      process.stdout.write(
        JSON.stringify({
          directory: ncx ? 'NCX' : 'EPUB3 nav',
          size: bytes.length,
          rangeRequests: requests,
          transferred,
        }) + '\n',
      );
    } finally {
      await file?.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('surfaces exhausted nav network failures instead of accepting a silently empty TOC', async () => {
    const bytes = fixture(false);
    const marker = Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub=');
    const offset = Buffer.from(bytes).indexOf(Buffer.from(marker));
    const endpoint = server(bytes, (start, end) => start <= offset && end >= offset);
    const file = await new RemoteFile(
      SOURCE,
      'book.epub',
      '',
      Date.now(),
      createMokeRemoteSourceTransport(SOURCE, endpoint.fetch)!,
    ).open();
    try {
      await expect(new DocumentLoader(file).open()).rejects.toMatchObject({
        code: 'online.network',
        status: 503,
      });
      expect(
        endpoint.reads.filter(([start, end]) => start <= offset && end >= offset),
      ).toHaveLength(3);
    } finally {
      await file.close();
    }
  });

  it('fetches the byte immediately beyond a cached inclusive range', async () => {
    const bytes = fixture(false);
    const endpoint = server(bytes);
    const file = await new RemoteFile(
      SOURCE,
      'book.epub',
      '',
      Date.now(),
      createMokeRemoteSourceTransport(SOURCE, endpoint.fetch)!,
    ).open();
    try {
      await file.slice(0, 1).arrayBuffer();
      const [, cachedEnd] = endpoint.reads.at(-1)!;
      expect(await file.slice(cachedEnd, cachedEnd + 2).arrayBuffer()).toEqual(
        bytes.slice(cachedEnd, cachedEnd + 2).buffer,
      );
    } finally {
      await file.close();
    }
  });

  it('retains typed failures through importer context without parsing error strings', () => {
    const error = new Error('Failed to open book', {
      cause: new MokeRemoteSourceError('online.range_unsupported', 200),
    });
    expect(mokeRemoteSourceErrorDetail(error)?.code).toBe('online.range_unsupported');
  });
});
