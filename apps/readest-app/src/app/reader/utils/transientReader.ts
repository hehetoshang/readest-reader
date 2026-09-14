import type { TOCItem } from '@/libs/document';
import type { Book } from '@/types/book';
import { isMokeRemoteSourceUrl } from '@/services/mokeRemoteSource';

function firstTocHref(toc?: readonly TOCItem[]): string | undefined {
  for (const item of toc ?? []) {
    const href = item.href || firstTocHref(item.subitems);
    if (href) return href;
  }
  return undefined;
}

/** Online cold opens should not download a large cover before showing text. */
export function getInitialReaderLocation(
  lastLocation: string | null | undefined,
  book: Pick<Book, 'url' | 'filePath'> | null | undefined,
  toc?: readonly TOCItem[],
): string | undefined {
  // Remote imports keep the source in `url`; native files use `filePath`.
  if (lastLocation || !isMokeRemoteSourceUrl(book?.url ?? book?.filePath ?? '')) {
    return lastLocation || undefined;
  }
  return firstTocHref(toc);
}

export async function runTransientReaderBootstrap(
  openFiles: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await openFiles();
  } catch (error) {
    console.error('Failed to initialize transient reader files:', error);
    onFailure(error);
  }
}
