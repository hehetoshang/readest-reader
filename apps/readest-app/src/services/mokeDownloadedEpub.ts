import { RemoteFile } from '@/utils/file';
import { getMokeHostLaunch, CLAIMED_DOWNLOAD_PATH } from './mokeHostLaunch';

export async function openMokeDownloadedEpub(): Promise<RemoteFile> {
  const launch = getMokeHostLaunch();
  const resource = launch?.claim.resource;
  if (!launch || resource?.kind !== 'downloaded-epub') throw new Error('reader_invalid_launch');

  let closed = false;
  return new RemoteFile(CLAIMED_DOWNLOAD_PATH, 'book.epub', '', Date.now(), {
    openWithHead: true,
    async fetch(path, init) {
      if (path !== CLAIMED_DOWNLOAD_PATH) throw new Error('reader_invalid_launch');
      if (closed) throw new DOMException('Download reader closed', 'AbortError');
      launch.assertActive();
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'Content-Type': 'application/epub+zip',
            'Content-Length': String(resource.size),
          },
        });
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
      if (!range) throw new Error('reader_invalid_launch');
      const offset = Number(range[1]);
      const bytes = await launch.readDownloadedRange(offset, Number(range[2]) - offset + 1);
      if (closed) throw new DOMException('Download reader closed', 'AbortError');
      return new Response(bytes, { status: 206 });
    },
    close() {
      closed = true;
    },
  }).open();
}
