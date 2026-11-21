/**
 * Moke 宿主集成桥接。
 *
 * 当阅读器嵌入 Moke 桌面客户端时（window.__MOKE_EMBEDDED === true），
 * 将阅读器事件上报给宿主，供拓展系统订阅。
 * 独立运行时（standalone）什么都不做。
 */

import type { Book } from '@/types/book';
import { mokeProgressStorageKey } from '@/helpers/mokeLaunchContext';
import { getMokeHostLaunch, hasMokeHostLookup } from './mokeHostLaunch';
import { progressPayload, writeManagedProgress } from './mokeProgressIdentity';

// ---------------------------------------------------------------------------
// Tauri invoke helper
// ---------------------------------------------------------------------------

let _invoke: (<T>(cmd: string, args: Record<string, unknown>) => Promise<T>) | null | undefined;

async function resolveInvoke() {
  if (_invoke !== undefined) return _invoke;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke;
  } catch (err) {
    // Don't cache failure permanently — transient import failures
    // (bundler race, dev HMR) should be retried next time.
    console.warn('[mokeBridge] @tauri-apps/api not available:', err);
    _invoke = null;
  }
  return _invoke;
}

function _doEmit(event: string, data: Record<string, unknown>): Promise<void> {
  return resolveInvoke().then((invoke) => {
    if (!invoke) return;
    return invoke('ext_reader_event', { event, data: withMokeContext(data) })
      .then(() => undefined)
      .catch((err) => {
        console.error('[mokeBridge] invoke ext_reader_event failed:', err);
      });
  });
}

// ---------------------------------------------------------------------------
// Throttle for high-frequency events (leading + trailing edge)
// ---------------------------------------------------------------------------

const THROTTLE_MS = 500;

interface ThrottleEntry {
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
  latest: Record<string, unknown>;
}

const _throttleEntries = new Map<string, ThrottleEntry>();

function throttledEmit(event: string, data: Record<string, unknown>) {
  const now = Date.now();
  let entry = _throttleEntries.get(event);

  if (!entry || now - entry.lastSent >= THROTTLE_MS) {
    // Leading edge: emit immediately.
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.lastSent = now;
    } else {
      entry = { lastSent: now, timer: null, latest: data };
      _throttleEntries.set(event, entry);
    }
    entry.latest = data;
    // Release the entry once the throttle window elapses with no further
    // events, so _throttleEntries never retains idle state.
    entry.timer = setTimeout(() => {
      _throttleEntries.delete(event);
    }, THROTTLE_MS);
    _doEmit(event, data);
    return;
  }

  // Within throttle window: store latest, schedule trailing emit.
  entry.latest = data;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => {
      _doEmit(event, entry.latest);
      entry.lastSent = Date.now();
      // Keep throttling for events that resume right after the trailing emit,
      // then release the entry once a full window passes without new events.
      entry.timer = setTimeout(() => {
        _throttleEntries.delete(event);
      }, THROTTLE_MS);
    },
    THROTTLE_MS - (now - entry.lastSent),
  );
}

/**
 * 仅测试用：当前节流表中存留的事件条目数。生产逻辑不依赖此值。
 */
export function throttleEntryCount(): number {
  return _throttleEntries.size;
}

// ---------------------------------------------------------------------------
// Embedded check
// ---------------------------------------------------------------------------

function isEmbedded(): boolean {
  return typeof window !== 'undefined' && !!window.__MOKE_EMBEDDED;
}

function withMokeContext(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof window === 'undefined') return data;

  const mokeBookId = window.__MOKE_BOOK_ID;
  if (!mokeBookId || data['moke_book_id']) return data;

  return {
    ...data,
    moke_book_id: String(mokeBookId),
  };
}

// ---------------------------------------------------------------------------
// Annotation-locate navigation correlation
// ---------------------------------------------------------------------------

const ANNOTATION_NAVIGATION_TTL_MS = 2 * 60 * 1000;

type MokeNavigationPhase = 'pending' | 'navigating' | 'complete';

export interface MokeAnnotationNavigationContext {
  id: string;
  phase: MokeNavigationPhase;
  delivered: boolean;
}

interface MokeAnnotationNavigationState {
  id: string;
  phase: 'pending' | 'navigating' | 'settled';
  lastContext: MokeAnnotationNavigationContext | null;
  lastDelivery: Promise<void> | null;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

let annotationNavigation: MokeAnnotationNavigationState | null = null;
let finishedAnnotationNavigationId: string | null = null;
let annotationDeliveryQueue = Promise.resolve();

function navigationIdFromRestoreProgress(): string | null {
  if (typeof window === 'undefined') return null;
  const progress = window.__MOKE_RESTORE_PROGRESS;
  if (!progress || typeof progress !== 'object') return null;
  const record = progress as Record<string, unknown>;
  return record['moke_navigation_kind'] === 'annotation-locate' &&
    typeof record['moke_navigation_id'] === 'string'
    ? record['moke_navigation_id']
    : null;
}

function getAnnotationNavigation(): MokeAnnotationNavigationState | null {
  const navigationId = navigationIdFromRestoreProgress();
  if (!navigationId || navigationId === finishedAnnotationNavigationId) return null;
  if (annotationNavigation?.id === navigationId) return annotationNavigation;
  if (annotationNavigation) finishAnnotationNavigation(annotationNavigation, false, false);

  const state: MokeAnnotationNavigationState = {
    id: navigationId,
    phase: 'pending',
    lastContext: null,
    lastDelivery: null,
    cleanupTimer: setTimeout(() => {
      if (annotationNavigation === state) finishAnnotationNavigation(state, false, true);
    }, ANNOTATION_NAVIGATION_TTL_MS),
  };
  annotationNavigation = state;
  return state;
}

function finishAnnotationNavigation(
  state: MokeAnnotationNavigationState,
  success: boolean,
  notifyHost: boolean,
): void {
  clearTimeout(state.cleanupTimer);
  if (annotationNavigation === state) annotationNavigation = null;
  finishedAnnotationNavigationId = state.id;
  if (notifyHost) {
    void _doEmit('annotation-locate:finished', {
      moke_navigation_id: state.id,
      success,
    });
  }
}

export function beginMokeAnnotationNavigation(): void {
  const state = getAnnotationNavigation();
  if (!state) return;
  state.phase = 'navigating';
  state.lastContext = null;
}

export function captureMokeAnnotationNavigation(): MokeAnnotationNavigationContext | null {
  const state = getAnnotationNavigation();
  if (!state) return null;
  const context: MokeAnnotationNavigationContext = {
    id: state.id,
    phase: state.phase === 'settled' ? 'complete' : state.phase,
    delivered: false,
  };
  state.lastContext = context;
  return context;
}

export function completeMokeAnnotationNavigation(): void {
  const state = getAnnotationNavigation();
  if (!state) return;
  state.phase = 'settled';
  const context = state.lastContext;
  if (context && !context.delivered) {
    // The raw relocate is waiting in FoliateViewer's rAF coalescer. Mutating
    // its captured context preserves correlation when it is emitted later.
    context.phase = 'complete';
  }
  finishAnnotationNavigationAfterDelivery(state);
}

export function cancelMokeAnnotationNavigation(notifyHost = true): void {
  const state = annotationNavigation ?? getAnnotationNavigation();
  if (state) finishAnnotationNavigation(state, false, notifyHost);
}

export function withMokeAnnotationNavigation(
  data: Record<string, unknown>,
  context: MokeAnnotationNavigationContext | null,
): Record<string, unknown> {
  if (!context) return data;
  const result = {
    ...data,
    moke_navigation_id: context.id,
    moke_navigation_kind: 'annotation-locate',
    moke_navigation_phase: context.phase,
  };
  context.delivered = true;
  return result;
}

function finishAnnotationNavigationAfterDelivery(state: MokeAnnotationNavigationState): void {
  if (state.phase !== 'settled' || !state.lastDelivery) return;
  const delivery = state.lastDelivery;
  void delivery.then(() => {
    if (
      annotationNavigation === state &&
      state.phase === 'settled' &&
      state.lastDelivery === delivery
    ) {
      // The finished receipt is emitted only after the last correlated page
      // event has reached the host, so it cannot clear suppression too early.
      finishAnnotationNavigation(state, true, true);
    }
  });
}

function isAnnotationNavigationEvent(data: Record<string, unknown>): boolean {
  return (
    data['moke_navigation_kind'] === 'annotation-locate' &&
    typeof data['moke_navigation_id'] === 'string'
  );
}

export interface MokeReaderErrorDetail {
  code: string;
  operation: 'progress.save';
  status?: number;
  retryable: boolean;
}

function progressStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function progressNumberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function saveProgressToLocalStorage(data: Record<string, unknown>): void {
  const mokeBookId = window.__MOKE_BOOK_ID;
  if (!mokeBookId) return;
  const serverUrl = typeof window.__MOKE_SERVER_URL === 'string' ? window.__MOKE_SERVER_URL : '';
  const payload = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(mokeBookId),
    reader_book_id: progressStringValue(data['book_id']),
    view_key: progressStringValue(data['view_key']),
    location: progressStringValue(data['location']),
    section_href: progressStringValue(data['section_href']),
    chapter: progressStringValue(data['chapter']),
    page: progressNumberValue(data['page']),
    total_pages: progressNumberValue(data['total_pages']),
    progress: progressNumberValue(data['progress']),
    fraction: progressNumberValue(data['fraction']),
    updated_at: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(
      mokeProgressStorageKey(serverUrl, String(mokeBookId)),
      JSON.stringify(payload),
    );
  } catch {
    // Local storage is best-effort (some ArkWeb custom-scheme contexts deny it).
  }
}

// Public API
// ---------------------------------------------------------------------------

/** Events that should be throttled to avoid flooding extension backends. */
const THROTTLED_EVENTS = new Set(['page:changed']);
let managedProgressTimer: ReturnType<typeof setTimeout> | null = null;
let managedProgress: Record<string, unknown> | null = null;
let managedClosing = false;
let managedProgressFailure: unknown;

function flushManagedProgress(): Promise<void> {
  if (managedProgressTimer) clearTimeout(managedProgressTimer);
  managedProgressTimer = null;
  const payload = managedProgress;
  managedProgress = null;
  if (managedProgressFailure) return Promise.reject(managedProgressFailure);
  if (!payload) return Promise.resolve();
  const launch = getMokeHostLaunch();
  if (!launch) return Promise.reject(new Error('reader_invalid_launch'));
  return Promise.resolve()
    .then(() => launch.progress(payload))
    .catch((error: unknown) => {
      managedProgressFailure = error;
      throw error;
    });
}

/**
 * 向 Moke 宿主上报阅读器事件。高频事件（如 page:changed）自动节流。
 *
 * 返回一个 Promise，resolve() 时表示事件已送达（或尽力送达）。
 * 调用方（尤其是关闭流程）应 await 此返回值，确保事件在窗口销毁前发出。
 */
export function emitReaderEvent(
  event: string,
  data: Record<string, unknown>,
  navigationGeneration?: number,
): Promise<void> {
  const launch = getMokeHostLaunch();
  if (hasMokeHostLookup() && !launch) return Promise.reject(new Error('reader_invalid_launch'));
  if (launch) {
    if (event === 'page:changed') {
      // Stop accepting relocations after the explicit trailing drain. Late
      // events cannot resurrect a returned/revoked document or enter a new source.
      if (managedClosing || !launch.isActive()) return Promise.resolve();
      if (
        launch.claim.localProgress &&
        (navigationGeneration === undefined || isAnnotationNavigationEvent(data))
      )
        return Promise.resolve();
      let payload: Record<string, unknown>;
      try {
        payload = progressPayload(data, launch);
        if (!launch.claim.localProgress && !isAnnotationNavigationEvent(data))
          writeManagedProgress(launch, payload, window.localStorage);
      } catch (error) {
        launch.markUnknown();
        window.dispatchEvent(
          new CustomEvent<MokeReaderErrorDetail>('moke:reader-error', {
            detail: { code: 'progress.unconfirmed', operation: 'progress.save', retryable: false },
          }),
        );
        return Promise.reject(error);
      }
      if (launch.claim.localProgress) {
        if (!payload['location'] && !payload['section_href']) return Promise.resolve();
        return launch.progress(payload, navigationGeneration);
      }
      managedProgress = payload;
      if (managedProgressTimer) clearTimeout(managedProgressTimer);
      managedProgressTimer = setTimeout(() => {
        void flushManagedProgress().catch(() => launch.markUnknown());
      }, THROTTLE_MS);
      return Promise.resolve();
    }
    if (event === 'book:closed') {
      managedClosing = true;
      cancelMokeAnnotationNavigation();
      return flushManagedProgress()
        .then(() => launch.close())
        .then(() => _doEmit(event, data));
    }
    // Managed progress has exactly one remote owner: native host take/ACK.
    // Never pass managed page events through the legacy direct-save path.
    return _doEmit(event, data);
  }
  if (!isEmbedded()) return Promise.resolve();

  const annotationNavigationEvent = event === 'page:changed' && isAnnotationNavigationEvent(data);

  // Correlated startup/annotation relocations are previews, not reading
  // progress. Skip local persistence for previews; genuine user turns have
  // no navigation marker and continue through the ordinary paths below.
  if (event === 'page:changed' && !annotationNavigationEvent) {
    saveProgressToLocalStorage(data);
  }

  if (event === 'book:closed') {
    cancelMokeAnnotationNavigation();
    return _doEmit(event, data);
  }

  // Never put correlation markers behind the generic trailing-edge throttle:
  // a completion receipt could otherwise clear the host state before the
  // delayed page event arrives. These launch-only events are low volume.
  if (annotationNavigationEvent) {
    const delivery = annotationDeliveryQueue.then(() => _doEmit(event, data));
    annotationDeliveryQueue = delivery;
    const navigationId = data['moke_navigation_id'];
    const state = annotationNavigation;
    if (state && state.id === navigationId) {
      state.lastDelivery = delivery;
      finishAnnotationNavigationAfterDelivery(state);
    }
    return delivery;
  }

  if (THROTTLED_EVENTS.has(event)) {
    throttledEmit(event, data);
    return Promise.resolve();
  }

  return _doEmit(event, data);
}

/**
 * 从 readest 的 Book 对象提取事件数据。
 */
export function bookEventData(book: Book): Record<string, unknown> {
  return {
    book_id: book.hash,
    title: book.title ?? '',
    author: book.author ?? '',
    format: book.format ?? '',
    cover_url: book.coverImageUrl ?? '',
    language: book.primaryLanguage ?? '',
  };
}
