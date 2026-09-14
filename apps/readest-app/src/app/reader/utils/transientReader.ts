import type { TOCItem } from '@/libs/document';

/** Online cold opens should not download a large cover before showing text. */
export function getInitialReaderLocation(
  lastLocation: string | null | undefined,
  online: boolean,
  toc?: readonly TOCItem[],
): string | undefined {
  if (lastLocation || !online) return lastLocation || undefined;
  for (const item of toc ?? []) {
    const href = item.href || getInitialReaderLocation(undefined, true, item.subitems);
    if (href) return href;
  }
  return undefined;
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
