import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, readerHttp } = vi.hoisted(() => ({ invoke: vi.fn(), readerHttp: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: readerHttp }));

const schema = 'moke.readest.legacy-mobile-progress.v1';
const claimCommand = 'moke_reader_legacy_progress_claim';
const captureCommand = 'moke_reader_legacy_progress_capture';
const closeCommand = 'moke_reader_legacy_progress_close';
const binding = { schema, launchId: 'host-launch', documentGeneration: 29 };
const source = 'https://books.test/collection/a';
const onlineFile = `${source}/api/book/42.epub`;
const onlineClaim = {
  ...binding,
  schema: 'moke.readest.host-launch.v1',
  phase: 'claimed',
  completion: 'pending',
  progressOwner: 'host',
  claimToken: 'native-token',
  bookId: '42',
  ownerDocumentGeneration: 28,
  epoch: 2,
  lastSequence: 0,
  source: { savedServerId: 'verified-entry', entryRevision: 'revision', libraryBaseUrl: source },
  resource: {
    url: onlineFile,
    effectiveBaseUrl: source,
    revision: null,
    size: 1234,
    etag: '"fixture"',
  },
};
const location = 'epubcfi(/6/2!/4/6)';
type Args = Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  readerHttp.mockReset();
  localStorage.clear();
});

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open({
  platform = 'android',
  lookup = 'host-launch',
  server = source,
  file = onlineFile,
  managed = false,
  claimStatus = 'claimed',
  capture,
  closeStatus = 'ready',
}: {
  platform?: string;
  lookup?: string;
  server?: string;
  file?: string;
  managed?: boolean;
  claimStatus?: string;
  capture?: (args: Args) => unknown;
  closeStatus?: string;
} = {}) {
  const writes: Args[] = [];
  let saved = 0;
  invoke.mockImplementation(async (command, args: Args) => {
    if (command === claimCommand) {
      expect(args).toEqual({ schema, launchId: binding.launchId });
      return { ...binding, status: claimStatus, onlineClaim };
    }
    if (command === captureCommand || command === closeCommand) {
      expect(args).toMatchObject({ ...binding, claimToken: 'native-token' });
      expect(args).not.toHaveProperty('accountId');
      expect(args).not.toHaveProperty('libraryBaseUrl');
    }
    if (command === captureCommand) {
      if (capture) return capture(args);
      const sequence = Number(args['sequence']);
      const status = sequence > saved ? 'saved' : sequence === saved ? 'duplicate' : 'superseded';
      if (status === 'saved') {
        saved = sequence;
        writes.push(args['payload'] as Args);
      }
      return { ...binding, status, sequence, lastSequence: saved };
    }
    if (command === closeCommand) {
      expect(args['lastSequence']).toBe(saved);
      return { ...binding, status: closeStatus, lastSequence: saved };
    }
    return undefined;
  });
  const query = new URLSearchParams({
    moke: '1',
    mokeBookId: '42',
    mokeRuntimePlatform: platform,
    mokeServerUrl: server,
    mokeReturnTo: '/library',
    file,
  });
  if (lookup) query.set('mokeLegacyProgressId', lookup);
  if (managed) query.set('mokeLaunchId', 'managed-launch');
  window.history.replaceState(null, '', `/readest/reader?${query}`);
  const { bootstrapMokeLaunchContext, mokeProgressStorageKey } = await import(
    '@/helpers/mokeLaunchContext'
  );
  const { bootstrapMokeLegacyProgress, getMokeLegacyProgress, getMokeLegacyResource } =
    await import('@/services/mokeLegacyProgress');
  bootstrapMokeLaunchContext();
  await bootstrapMokeLegacyProgress();
  const { emitReaderEvent } = await import('@/services/mokeBridge');
  const { eventDispatcher } = await import('@/utils/event');
  const { navigateReaderBack } = await import('@/utils/readerBack');
  const navigateMoke = vi.fn(async () => undefined);
  const navigateDocument = vi.fn();
  const back = () =>
    navigateReaderBack({
      search: window.location.search,
      runtimePlatform: platform,
      isReaderWindow: false,
      navigateMoke,
      navigateDocument,
      closeReaderOrGoToLibrary: vi.fn(async () => undefined),
      navigateReadestLibrary: vi.fn(),
      onNativeNavigationError: vi.fn(),
    });
  const page = (position: string, generation = 2) =>
    emitReaderEvent(
      'page:changed',
      { book_id: 'reader-hash', location: position, page: 7 },
      generation,
    );
  return {
    writes,
    page,
    back,
    eventDispatcher,
    navigateMoke,
    navigateDocument,
    local: () => JSON.parse(localStorage.getItem(mokeProgressStorageKey(server, '42')) ?? 'null'),
    close: () => emitReaderEvent('book:closed', {}),
    progress: getMokeLegacyProgress(),
    resource: getMokeLegacyResource(),
  };
}

const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const hidden = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
};

describe.each(['ohos', 'android', 'ios'])('%s single-WebView legacy progress', (platform) => {
  it.each([
    'debounce',
    'book:closed',
    'pagehide',
    'visibilitychange',
  ])('hands the latest position to the host once on %s', async (trigger) => {
    const reader = await open({ platform });
    await reader.page('epubcfi(/6/2!/4/2)');
    await vi.advanceTimersByTimeAsync(400);
    if (trigger === 'visibilitychange' || trigger === 'pagehide') {
      reader.eventDispatcher.onSync('flush-legacy-reader-relocate', () => {
        void reader.page(location);
        return false;
      });
    } else {
      await reader.page(location);
    }
    expect(reader.writes).toHaveLength(0);
    if (trigger === 'debounce') {
      await vi.advanceTimersByTimeAsync(1199);
      expect(reader.writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
    } else if (trigger === 'book:closed') {
      await reader.close();
      await Promise.all([reader.back(), reader.back()]);
      expect(calls(closeCommand)).toHaveLength(1);
      expect(
        platform === 'ios' ? reader.navigateDocument : reader.navigateMoke,
      ).toHaveBeenCalledExactlyOnceWith('/library');
    } else if (trigger === 'pagehide') {
      window.dispatchEvent(new Event('pagehide'));
    } else {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(reader.writes).toHaveLength(0);
      hidden();
    }
    expect(reader.local()).toMatchObject({ location, moke_book_id: '42' });
    expect(reader.writes).toEqual([expect.objectContaining({ location, page: 7 })]);
    await reader.page(location);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls(captureCommand)).toHaveLength(1);
    expect(readerHttp).not.toHaveBeenCalled();
  });
});

it.each([
  { lookup: '' },
  { platform: 'windows' },
  { server: '' },
  { file: '/downloads/42.epub' },
  { claimStatus: 'unavailable' },
  { claimStatus: 'revoked' },
  { file: 'https://books.test/collection/b/api/book/42.epub' },
])('keeps the fallback usable without a verified host claim (%j)', async (options) => {
  const reader = await open(options);
  expect(reader.progress).toBeUndefined();
  await reader.page(location);
  await reader.close();
  await reader.back();
  expect(reader.local()).toMatchObject({ location });
  expect(calls(captureCommand)).toHaveLength(0);
  expect(calls(closeCommand)).toHaveLength(0);
  expect(readerHttp).not.toHaveBeenCalled();
});

it('opens a sealed publication without enabling host progress when the account is unconfirmed', async () => {
  const reader = await open({ claimStatus: 'local-only' });
  expect(reader.resource?.sourcePath).toBe(onlineFile);
  expect(reader.progress).toBeUndefined();
  await reader.page(location);
  await reader.back();
  expect(reader.local()).toMatchObject({ location });
  expect(calls(captureCommand)).toHaveLength(0);
  expect(calls(closeCommand)).toHaveLength(0);
});

it('does not negotiate on the managed route', async () => {
  await open({ managed: true });
  expect(invoke).not.toHaveBeenCalled();
});

it('does not promote startup or annotation positions', async () => {
  const reader = await open();
  const { emitReaderEvent } = await import('@/services/mokeBridge');
  await emitReaderEvent('page:changed', { location });
  await emitReaderEvent(
    'page:changed',
    {
      location,
      moke_navigation_id: 'preview',
      moke_navigation_kind: 'annotation-locate',
    },
    2,
  );
  await reader.close();
  expect(reader.local()).toBeNull();
  expect(calls(captureCommand)).toHaveLength(0);
  expect(calls(closeCommand)[0]?.[1]).toMatchObject({ lastSequence: 0 });
});

it('retries a definite write failure only with the same sequence and position', async () => {
  const capture = vi
    .fn()
    .mockReturnValueOnce({ ...binding, sequence: 1, lastSequence: 0, status: 'write-failed' })
    .mockReturnValueOnce({ ...binding, sequence: 1, lastSequence: 1, status: 'duplicate' });
  const reader = await open({ capture });
  await reader.page(location);
  hidden();
  await vi.advanceTimersByTimeAsync(1500);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture.mock.calls[0]).toEqual(capture.mock.calls[1]);
});

it.each([
  'unknown',
  'revoked',
  'write-failed',
  'stale-generation',
])('keeps the local frame and refuses an unconfirmed return on %s', async (status) => {
  const reader = await open({
    capture: () =>
      status === 'unknown'
        ? new Promise(() => undefined)
        : {
            ...binding,
            sequence: 1,
            lastSequence: 0,
            status: status === 'stale-generation' ? 'saved' : status,
            documentGeneration: status === 'stale-generation' ? 28 : binding.documentGeneration,
          },
  });
  await reader.page(location);
  const expected = expect(reader.back()).rejects.toThrow(
    status === 'write-failed'
      ? 'reader_legacy_progress_write_failed'
      : 'reader_legacy_progress_unconfirmed',
  );
  await vi.advanceTimersByTimeAsync(2500);
  await expected;
  expect(reader.local()).toMatchObject({ location });
  expect(calls(captureCommand)).toHaveLength(status === 'write-failed' ? 3 : 1);
  expect(calls(closeCommand)).toHaveLength(0);
  expect(reader.navigateMoke).not.toHaveBeenCalled();
  expect(reader.navigateDocument).not.toHaveBeenCalled();
});

it('submits a pending tail on pagehide while an earlier receipt is still in flight', async () => {
  let settleFirst: (value: unknown) => void = () => undefined;
  const reader = await open({
    capture: ({ sequence }) =>
      sequence === 1
        ? new Promise((resolve) => {
            settleFirst = resolve;
          })
        : { ...binding, status: 'saved', sequence, lastSequence: sequence },
  });
  await reader.page('epubcfi(/6/2!/4/2)');
  await vi.advanceTimersByTimeAsync(1200);
  await reader.page(location);
  window.dispatchEvent(new Event('pagehide'));
  expect(calls(captureCommand).map(([, args]) => args.sequence)).toEqual([1, 2]);
  settleFirst({ ...binding, status: 'superseded', sequence: 1, lastSequence: 2 });
  await expect(reader.back()).rejects.toThrow('reader_legacy_progress_unconfirmed');
  expect(calls(closeCommand)).toHaveLength(0);
});

it('requires the native close receipt even when every frame is saved', async () => {
  const reader = await open({ closeStatus: 'unavailable', platform: 'ios' });
  await reader.page(location);
  await expect(reader.back()).rejects.toThrow('reader_legacy_progress_unconfirmed');
  expect(calls(closeCommand)[0]?.[1]).toMatchObject({ lastSequence: 1 });
  expect(reader.navigateDocument).not.toHaveBeenCalled();
});
