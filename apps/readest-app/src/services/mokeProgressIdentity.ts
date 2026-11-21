import type { Book, BookConfig } from '@/types/book';
import { getMokeHostLaunch, type MokeHostLaunch } from './mokeHostLaunch';
import { md5 } from '@/utils/md5';

const PREFIX = 'moke-reader-progress-v1:';

export function managedBookIdentity(sourceUrl: string): string | null {
  const launch = getMokeHostLaunch();
  if (!launch || sourceUrl !== launch.claim.resource.url) return null;
  launch.assertActive();
  return launch.identity;
}

export function managedBookFields(sourceUrl: string, contentHash: string) {
  const identity = managedBookIdentity(sourceUrl);
  return identity
    ? {
        hash: md5(`moke-progress-v1:${identity}`),
        mokeIdentity: identity,
        mokeContentHash: contentHash,
      }
    : { hash: contentHash };
}

export function progressPayload(
  data: Record<string, unknown>,
  launch: MokeHostLaunch,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: launch.claim.bookId,
    updated_at: new Date().toISOString(),
  };
  const strings = [
    'view_key',
    'location',
    'section_href',
    'chapter',
    'moke_navigation_id',
    'moke_navigation_kind',
    'moke_navigation_phase',
  ];
  for (const key of strings) if (typeof data[key] === 'string') payload[key] = data[key];
  if (typeof data['book_id'] === 'string') payload['reader_book_id'] = data['book_id'];
  for (const key of ['page', 'total_pages', 'progress', 'fraction']) {
    if (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0)
      payload[key] = data[key];
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 65536)
    throw new Error('reader_progress_invalid');
  return payload;
}

export function readManagedProgress(
  launch: MokeHostLaunch,
  storage: Pick<Storage, 'getItem'>,
): Record<string, unknown> | null {
  launch.assertActive();
  // A legacy key with this explicit original full base has provable ownership. The empty key is never read.
  const keys = [
    PREFIX + launch.identity,
    `moke:reading-progress:${encodeURIComponent(launch.claim.source.libraryBaseUrl)}:${encodeURIComponent(launch.claim.bookId)}`,
  ];
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object') {
        const p = value as Record<string, unknown>;
        if (
          p['schema'] === 'moke.readest.progress.v1' &&
          p['reader'] === 'readest' &&
          p['moke_book_id'] === launch.claim.bookId
        )
          return p;
      }
    } catch {
      /* Preserve malformed originals; do not infer a position. */
    }
  }
  return null;
}

export function writeManagedProgress(
  launch: MokeHostLaunch,
  payload: Record<string, unknown>,
  storage: Pick<Storage, 'setItem'>,
): void {
  launch.assertActive();
  const persistent = { ...payload };
  for (const key of ['moke_navigation_id', 'moke_navigation_kind', 'moke_navigation_phase'])
    delete persistent[key];
  storage.setItem(PREFIX + launch.identity, JSON.stringify(persistent));
}

/** Reuse presentation settings only; anonymous byte-hash positions have no source provenance. */
export function presentationConfig(config: BookConfig): BookConfig {
  return { updatedAt: 0, viewSettings: config.viewSettings, searchConfig: config.searchConfig };
}

export function restoreManagedConfig(book: Book, config: BookConfig): BookConfig {
  const launch = getMokeHostLaunch();
  if (!book.mokeIdentity || !launch || book.mokeIdentity !== launch.identity) return config;
  launch.assertActive();
  const progress = readManagedProgress(launch, window.localStorage);
  if (!progress) return config;
  // The local snapshot is captured on relocate, before the slower config autosave.
  // An older snapshot cannot roll a newer identity-scoped config backwards.
  const snapshotTime = Date.parse(String(progress['updated_at'] || ''));
  if (
    (config.location || config.progress) &&
    Number.isFinite(config.updatedAt) &&
    Number.isFinite(snapshotTime) &&
    config.updatedAt > snapshotTime
  )
    return config;
  const result = { ...config };
  if (typeof progress['location'] === 'string') result.location = progress['location'];
  if (
    typeof progress['page'] === 'number' &&
    typeof progress['total_pages'] === 'number' &&
    Number.isFinite(progress['page']) &&
    Number.isFinite(progress['total_pages']) &&
    progress['page'] >= 0 &&
    progress['total_pages'] > 0
  )
    result.progress = [progress['page'], progress['total_pages']];
  return result;
}
