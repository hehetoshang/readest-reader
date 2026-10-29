export async function closeReaderAndNavigateBack(
  closeReader: () => Promise<void>,
  navigateBack: () => void | Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = closeReader();
    if (timeoutMs === undefined) await closing;
    else await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reader recovery cleanup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await navigateBack();
  }
}

export type ReaderReturnTarget = { kind: 'moke'; path: '/library' } | { kind: 'readest' };

/** Resolve only the host route explicitly supported by the embedded reader. */
export function resolveReaderReturnTarget(search: string): ReaderReturnTarget {
  const params = new URLSearchParams(search);
  if (params.get('moke') === '1' && params.get('mokeReturnTo') === '/library') {
    return { kind: 'moke', path: '/library' };
  }
  return { kind: 'readest' };
}

interface ReaderBackNavigation {
  search: string;
  runtimePlatform?: string | null;
  isReaderWindow: boolean;
  recover?: boolean;
  navigateMoke: (path: '/library') => Promise<unknown>;
  closeReaderOrGoToLibrary: () => Promise<void>;
  navigateReadestLibrary: () => void;
  navigateDocument: (path: '/library') => void;
  onNativeNavigationError: (error: unknown) => void;
}

/** Host routes must bypass Next's /readest basePath, including error recovery. */
export async function navigateReaderBack({
  search,
  runtimePlatform,
  isReaderWindow,
  recover = false,
  navigateMoke,
  closeReaderOrGoToLibrary,
  navigateReadestLibrary,
  navigateDocument,
  onNativeNavigationError,
}: ReaderBackNavigation): Promise<void> {
  const target = resolveReaderReturnTarget(search);
  if (target.kind === 'readest') {
    if (recover) await closeReaderOrGoToLibrary();
    else navigateReadestLibrary();
    return;
  }
  if (runtimePlatform === 'android' || runtimePlatform === 'ohos') {
    try {
      await navigateMoke(target.path);
      return;
    } catch (error) {
      onNativeNavigationError(error);
    }
  }
  if (isReaderWindow) {
    await closeReaderOrGoToLibrary();
  } else {
    navigateDocument(target.path);
  }
}
