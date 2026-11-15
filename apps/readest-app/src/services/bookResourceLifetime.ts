import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';

const releases = new Map<string, Set<Promise<void>>>();

/** No idle document cache: live views (including opens) and TTS own the bytes. */
export async function releaseUnusedBookData(id: string): Promise<void> {
  if (Object.keys(useReaderStore.getState().viewStates).some(key => key.split('-')[0] === id)) return;
  if (ttsSessionManager.hasBookResources(id)) return;
  const store = useBookDataStore.getState();
  const data = store.getBookData(id);
  if (!data) {
    await Promise.all(releases.get(id) ?? []);
    return;
  }
  // Remove before awaiting: a concurrent reopen must acquire a fresh document.
  store.clearBookData(id);
  const file = data.file as (File & { close?: () => Promise<void> }) | null;
  const releasing = (async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => data.bookDoc?.destroy?.()),
      Promise.resolve().then(() => file?.close?.()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to release book resources');
  })();
  const pending = releases.get(id) ?? new Set<Promise<void>>();
  pending.add(releasing);
  releases.set(id, pending);
  try {
    await Promise.all(pending);
  } finally {
    pending.delete(releasing);
    if (!pending.size) releases.delete(id);
  }
}
