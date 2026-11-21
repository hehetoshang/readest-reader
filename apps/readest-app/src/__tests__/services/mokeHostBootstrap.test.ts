import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFixture } from '../helpers/hostLaunchFixture';
const fixture = vi.hoisted(() => ({ invoke: vi.fn(), directPost: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: fixture.directPost }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ listen: vi.fn(async () => () => {}) }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  window.history.replaceState(null, '', '/readest/reader');
  window.__MOKE_EMBEDDED = false;
});
describe('controlled document bootstrap', () => {
  it('rejects unclaimed query sources before transport or generic RemoteFile can open them', async () => {
    window.history.replaceState(
      null,
      '',
      '/readest/reader?moke=1&mokeSourceServerUrl=http://books.example/a&mokeBookId=42',
    );
    window.__MOKE_EMBEDDED = true;
    window.__MOKE_SOURCE_SERVER_URL = 'http://books.example/a';
    window.__MOKE_BOOK_ID = '42';
    const { createMokeRemoteSourceTransport, isMokeRemoteSourceUrl } = await import(
      '@/services/mokeRemoteSource'
    );
    const url = 'http://books.example/a/api/book/42.epub';
    expect(isMokeRemoteSourceUrl(url)).toBe(false);
    expect(() => createMokeRemoteSourceTransport(url)).toThrow();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.directPost).not.toHaveBeenCalled();
  });
  it.each([
    'mokeBookId=43',
    'file=http://evil.example/a.epub',
    'mokeRestoreProgress=%7B%7D',
    'cfi=foreign',
  ])('rejects lookup mixed with external context: %s', async (extra) => {
    window.history.replaceState(
      null,
      '',
      `/readest/reader?moke=1&mokeLaunchId=synthetic-launch&${extra}`,
    );
    const { bootstrapMokeHostLaunch } = await import('@/services/mokeHostLaunch');
    await expect(bootstrapMokeHostLaunch()).rejects.toThrow();
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
  it('derives the file and book solely from caller-bound claim, with no remote restore snapshot or server POST owner', async () => {
    window.history.replaceState(null, '', '/readest/reader?moke=1&mokeLaunchId=synthetic-launch');
    window.__MOKE_SERVER_URL = 'http://old.example';
    window.__MOKE_RESTORE_PROGRESS = { location: 'foreign' };
    fixture.invoke.mockResolvedValue(claimFixture());
    const { bootstrapMokeHostLaunch } = await import('@/services/mokeHostLaunch');
    const launch = await bootstrapMokeHostLaunch();
    expect(fixture.invoke).toHaveBeenCalledOnce();
    expect(fixture.invoke).toHaveBeenCalledWith('moke_reader_claim', {
      launchId: 'synthetic-launch',
    });
    expect(window.OPEN_WITH_FILES).toEqual([launch.claim.resource.url]);
    expect(window.__MOKE_SERVER_URL).toBeNull();
    expect(window.__MOKE_RESTORE_PROGRESS).toBeNull();
    expect(fixture.directPost).not.toHaveBeenCalled();
  });
  it('stops an unsupported backend before file handoff', async () => {
    window.history.replaceState(null, '', '/readest/reader?moke=1&mokeLaunchId=synthetic-launch');
    window.OPEN_WITH_FILES = null;
    fixture.invoke.mockRejectedValueOnce({ code: 'reader_unsupported' });
    const { bootstrapMokeHostLaunch } = await import('@/services/mokeHostLaunch');
    await expect(bootstrapMokeHostLaunch()).rejects.toEqual({ code: 'reader_unsupported' });
    expect(window.OPEN_WITH_FILES).toBeNull();
    expect(fixture.directPost).not.toHaveBeenCalled();
  });
});
