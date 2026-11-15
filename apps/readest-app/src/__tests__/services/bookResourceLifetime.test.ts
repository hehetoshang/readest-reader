import { beforeEach, expect, it, vi } from 'vitest';
import { releaseUnusedBookData } from '@/services/bookResourceLifetime';

const state = vi.hoisted(() => ({
  views: {} as Record<string, unknown>, heldByTTS: false,
  data: null as null | { file: { close: ReturnType<typeof vi.fn> }; bookDoc: { destroy: ReturnType<typeof vi.fn> } },
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: { getState: () => ({ viewStates: state.views }) },
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: { getState: () => ({
    getBookData: () => state.data,
    clearBookData: () => { state.data = null; },
  }) },
}));
vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: { hasBookResources: () => state.heldByTTS },
}));
beforeEach(() => {
  state.views = {};
  state.heldByTTS = false;
  state.data = { file: { close: vi.fn().mockResolvedValue(undefined) }, bookDoc: { destroy: vi.fn().mockResolvedValue(undefined) } };
});
it('keeps documents owned by another view, including a loading view', async () => {
  const data = state.data!;
  state.views = { 'hash-second': { loading: true } };
  await releaseUnusedBookData('hash');
  expect(state.data).toBe(data);
  expect(data.bookDoc.destroy).not.toHaveBeenCalled();
});
it('keeps background TTS and teardown resources until the final holder releases', async () => {
  const data = state.data!;
  state.heldByTTS = true;
  await releaseUnusedBookData('hash');
  expect(state.data).toBe(data);
  state.heldByTTS = false;
  await releaseUnusedBookData('hash');
  expect(state.data).toBeNull();
  expect(data.bookDoc.destroy).toHaveBeenCalledTimes(1);
  expect(data.file.close).toHaveBeenCalledTimes(1);
});
it('concurrent last-holder releases detach once and await both cleanups', async () => {
  const data = state.data!;
  let finish!: () => void;
  data.bookDoc.destroy.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const release = releaseUnusedBookData('hash');
  expect(state.data).toBeNull();
  const secondRelease = releaseUnusedBookData('hash');
  await Promise.resolve();
  finish();
  await release;
  await secondRelease;
  expect(data.bookDoc.destroy).toHaveBeenCalledTimes(1);
  expect(data.file.close).toHaveBeenCalledTimes(1);
});
it('still closes the file when document destruction fails', async () => {
  const data = state.data!;
  data.bookDoc.destroy.mockRejectedValue(new Error('worker failed'));
  await expect(releaseUnusedBookData('hash')).rejects.toThrow('release book');
  expect(data.file.close).toHaveBeenCalledTimes(1);
});
