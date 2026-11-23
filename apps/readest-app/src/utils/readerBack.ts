import { getMokeHostLaunch, hasMokeHostLookup } from '@/services/mokeHostLaunch';
import { getMokeLegacyProgress } from '@/services/mokeLegacyProgress';
import { getMokeDownloadedBookIdentity } from '@/services/mokeDownloadedBookIdentity';

export async function closeReaderAndNavigateBack(
  closeReader: () => Promise<void>,
  navigateBack: () => void | Promise<void>,
  timeoutMs?: number,
): Promise<void> {
  const launch = getMokeHostLaunch();
  if (launch || hasMokeHostLookup()) {
    await closeReader();
    if (!launch) throw new Error('reader_invalid_launch');
    await launch.close();
    await navigateBack();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = closeReader();
    if (timeoutMs === undefined) await closing;
    else
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Reader recovery cleanup timed out')),
            timeoutMs,
          );
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
  prepareManagedMobileReturn?: () => Promise<void>;
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
  prepareManagedMobileReturn,
  navigateMoke,
  closeReaderOrGoToLibrary,
  navigateReadestLibrary,
  navigateDocument,
  onNativeNavigationError,
}: ReaderBackNavigation): Promise<void> {
  const launch = getMokeHostLaunch();
  if (launch) {
    if (launch.claim.localProgress?.returnTarget === 'mobile-library') {
      if (isReaderWindow) throw new Error('reader_unsupported');
      await launch.returnToLibrary(prepareManagedMobileReturn, () => navigateMoke('/library'));
      return;
    }
    await launch.close();
    // The fixed host target carries only moke and mokeLaunchId. Its desktop
    // window returns by closing; full-document/mobile ownership remains gated.
    if (!isReaderWindow) throw new Error('reader_unsupported');
    await closeReaderOrGoToLibrary();
    return;
  }
  if (hasMokeHostLookup()) throw new Error('reader_invalid_launch');
  if (getMokeDownloadedBookIdentity()) {
    if (isReaderWindow) await closeReaderOrGoToLibrary();
    else if (runtimePlatform === 'ios') navigateDocument('/library');
    else await navigateMoke('/library');
    return;
  }
  const target = resolveReaderReturnTarget(search);
  const legacy = getMokeLegacyProgress();
  if (legacy) {
    if (isReaderWindow || target.kind !== 'moke') throw new Error('reader_unsupported');
    await legacy.returnToLibrary(() =>
      runtimePlatform === 'ios' ? navigateDocument(target.path) : navigateMoke(target.path),
    );
    return;
  }
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
