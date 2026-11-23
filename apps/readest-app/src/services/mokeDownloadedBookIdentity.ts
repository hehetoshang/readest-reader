const SCHEMA = 'moke.readest.downloaded-book-identity.v1';
const LOOKUP = 'mokeDownloadIdentityId';

interface DownloadedBookIdentity {
  schema: typeof SCHEMA;
  sourcePath: string;
  identityKey: string;
}

let current: Readonly<DownloadedBookIdentity> | undefined;
let bootstrap: Promise<void> | undefined;
let documentHidden = false;

const invalid = () => new Error('reader_invalid_launch');

export function hasMokeDownloadedBookLookup(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has(LOOKUP);
}

export function getMokeDownloadedBookIdentity() {
  return current;
}

export function downloadedBookIdentityForPath(sourcePath: unknown): string | undefined {
  if (!current) return;
  if (documentHidden || sourcePath !== current.sourcePath) throw invalid();
  return JSON.stringify([current.schema, current.identityKey]);
}

function validateClaim(value: unknown): Readonly<DownloadedBookIdentity> {
  if (!value || typeof value !== 'object') throw invalid();
  const { schema, sourcePath, identityKey } = value as Partial<DownloadedBookIdentity>;
  if (
    schema !== SCHEMA ||
    typeof sourcePath !== 'string' ||
    !/^(?:\/(?![\\/])|(?:\\\\\?\\)?[a-z]:[\\/])/i.test(sourcePath) ||
    [...sourcePath].some((char) => char.charCodeAt(0) < 32) ||
    typeof identityKey !== 'string' ||
    !identityKey.trim() ||
    identityKey.length > 512
  ) {
    throw invalid();
  }
  return Object.freeze({ schema, sourcePath, identityKey });
}

export function bootstrapMokeDownloadedBookIdentity(): Promise<void> {
  return (bootstrap ??= claimDownloadedBook());
}

async function claimDownloadedBook(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const ids = params.getAll(LOOKUP);
  if (
    params.get('moke') !== '1' ||
    params.getAll('moke').length !== 1 ||
    ids.length !== 1 ||
    !/^[a-z0-9._~-]{1,128}$/i.test(ids[0] ?? '') ||
    [...params.keys()].some((key) => key !== 'moke' && key !== LOOKUP)
  ) {
    throw invalid();
  }
  window.addEventListener(
    'pagehide',
    () => {
      documentHidden = true;
    },
    { once: true },
  );
  const { invoke } = await import('@tauri-apps/api/core');
  if (documentHidden) throw invalid();
  const result = await invoke('moke_reader_claim_downloaded_book_identity', { launchId: ids[0] });
  if (documentHidden) throw invalid();
  current = validateClaim(result);
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_BOOK_ID = null;
  window.__MOKE_SERVER_URL = null;
  window.__MOKE_SOURCE_SERVER_URL = null;
  window.__MOKE_RESTORE_PROGRESS = null;
  window.OPEN_WITH_FILES = [current.sourcePath];
}
