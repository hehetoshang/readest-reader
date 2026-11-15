import { type BookData, useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { BookDoc } from '@/libs/document';

const releases = new Map<string, Set<Promise<void>>>();
const retired = new Map<string, Set<BookData>>();
const cancelledInitializations = new Map<string, Set<Promise<void>>>();
const teardowns = new Map<string, Set<Promise<void>>>();
const documentHolders = new WeakMap<BookDoc, Set<object>>();
const generationReleases = new WeakMap<object, Promise<void>>();
const viewDocuments = new Map<string, { document: BookDoc; release: () => Promise<void> }>();

/** Hold the exact document, including across async renderer/TTS teardown. */
export function holdBookDocument(id: string, document: BookDoc): () => Promise<void> {
  if (generationReleases.has(document)) throw new Error('Cannot reuse a releasing book document');
  const holders = documentHolders.get(document) ?? new Set<object>();
  const token = {};
  holders.add(token);
  documentHolders.set(document, holders);
  let released: Promise<void> | undefined;
  return () => {
    if (!released) {
      holders.delete(token);
      // The holder may be finishing a tracked teardown. Never await that
      // teardown's own completion fence from inside its resource release.
      released = collectUnusedBookData(id, []);
    }
    return released;
  };
}

export function trackBookResourceTeardown(id: string, completed: Promise<void>): void {
  const pending = teardowns.get(id) ?? new Set<Promise<void>>();
  pending.add(completed);
  teardowns.set(id, pending);
  const forget = () => {
    pending.delete(completed);
    if (!pending.size && teardowns.get(id) === pending) teardowns.delete(id);
  };
  void completed.then(forget, forget);
}

/** The view slot protects a published generation before its renderer mounts.
 * Existing renderers and TTS carry independent leases and can outlive this slot.
 */
export function setViewBookDocument(key: string, document: BookDoc | null): void {
  const previous = viewDocuments.get(key);
  if (previous?.document === document) return;
  if (document) {
    viewDocuments.set(key, { document, release: holdBookDocument(key.split('-')[0]!, document) });
  } else viewDocuments.delete(key);
  void previous?.release().catch(error => console.warn('Failed to release replaced view:', error));
}

/** Retired means replaced in the shared store, not necessarily unused. */
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
  const identity = data.bookDoc ?? data.file ?? data;
  const existing = generationReleases.get(identity);
  if (existing) return existing;
  const file = data.file as (File & { close?: () => Promise<void> }) | null;
  const releasing = (async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => data.bookDoc?.destroy?.()),
      Promise.resolve().then(() => file?.close?.()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to release book resources');
  })();
  generationReleases.set(identity, releasing);
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
    ...(teardowns.get(id) ?? []),
  ];
  return collectUnusedBookData(id, pending);
}

async function collectUnusedBookData(id: string, pending: Promise<void>[]): Promise<void> {
  const held = Object.keys(useReaderStore.getState().viewStates).some(key => key.split('-')[0] === id)
    || ttsSessionManager.hasBookResources(id);
  const store = useBookDataStore.getState();
  const generations = retired.get(id);
  if (generations) {
    for (const generation of generations) {
      if (generation.bookDoc && documentHolders.get(generation.bookDoc)?.size) continue;
      generations.delete(generation);
      pending.push(releaseGeneration(id, generation));
    }
    if (!generations.size) retired.delete(id);
  }
  if (!held) {
    const data = store.getBookData(id);
    if (data) {
      // Detach before awaiting: reopening must acquire a fresh document.
      store.clearBookData(id);
      if (data.bookDoc && documentHolders.get(data.bookDoc)?.size) retireBookData(id, data);
      else pending.push(releaseGeneration(id, data));
    }
  }
  // A failed old generation must not make close return before the other
  // generations (or an abort-ignoring parser) have completed their cleanup.
  const results = await Promise.allSettled(pending);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Failed to release book resources');
}
