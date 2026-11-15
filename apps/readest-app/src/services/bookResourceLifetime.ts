import { type BookData, useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';

const releases = new Map<string, Set<Promise<void>>>();
const retired = new Map<string, Set<BookData>>();
const cancelledInitializations = new Map<string, Set<Promise<void>>>();

/** A reload transfers the replaced generation to the same view/TTS lifetime.
 * Keep all generations until the last holder exits: a parallel renderer or a
 * detached TTS controller can still be reading an older document.
 */
export function retireBookData(id: string, data: BookData): void {
  const generations = retired.get(id) ?? new Set<BookData>();
  generations.add(data);
  retired.set(id, generations);
}

/** Register synchronously at cancellation, before another open can take the key.
 * Completion means the parser AND unpublished document/file cleanup have settled.
 * Only cancelled opens participate; a later live open never extends this fence.
 */
export function trackCancelledBookInitialization(id: string, completed: Promise<void>): void {
  const pending = cancelledInitializations.get(id) ?? new Set<Promise<void>>();
  pending.add(completed);
  cancelledInitializations.set(id, pending);
  void completed.then(() => {
    pending.delete(completed);
    if (!pending.size && cancelledInitializations.get(id) === pending) {
      cancelledInitializations.delete(id);
    }
  });
}

function releaseGeneration(id: string, data: BookData): Promise<void> {
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
  // Register both handlers now, including for background last-holder releases.
  void releasing.then(() => forgetRelease(), () => forgetRelease());
  function forgetRelease() {
    pending.delete(releasing);
    if (!pending.size && releases.get(id) === pending) releases.delete(id);
  }
  return releasing;
}

/** No idle document cache: live views (including opens) and TTS own the bytes. */
export async function releaseUnusedBookData(id: string): Promise<void> {
  // Snapshot before any await. Never join a subsequently opened generation or
  // call back into this function from the initialization's own cleanup.
  const pending = [
    ...(cancelledInitializations.get(id) ?? []),
    ...(releases.get(id) ?? []),
  ];
  const held = Object.keys(useReaderStore.getState().viewStates).some(key => key.split('-')[0] === id)
    || ttsSessionManager.hasBookResources(id);
  const store = useBookDataStore.getState();
  if (!held) {
    const generations = retired.get(id) ?? new Set<BookData>();
    retired.delete(id);
    const data = store.getBookData(id);
    if (data) {
      // Detach before awaiting: reopening must acquire a fresh document.
      store.clearBookData(id);
      generations.add(data);
    }
    for (const generation of generations) pending.push(releaseGeneration(id, generation));
  }
  // A failed old generation must not make close return before the other
  // generations (or an abort-ignoring parser) have completed their cleanup.
  const results = await Promise.allSettled(pending);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Failed to release book resources');
}
