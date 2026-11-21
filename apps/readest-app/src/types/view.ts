import { BookDoc } from '@/libs/document';
import { BookNote, BookSearchConfig, BookSearchResult } from '@/types/book';
import { TTSGranularity } from '@/services/tts';
import { TTS } from 'foliate-js/tts.js';
import type { MediaOverlayTTS } from '@/services/tts/mediaOverlay/MediaOverlayTTS';
import { LocaleWithTextInfo } from './misc';

// The mark source driving Read Aloud: foliate's text segmentation for
// synthesized speech, or the book's own Media Overlay pars when playing its
// recorded narration. Both expose the same navigation surface.
export type ViewTTS = TTS | MediaOverlayTTS;

export const NOTE_PREFIX = 'foliate-note:';

type RangeAnchor = (doc: Document) => Range;

export interface Renderer extends HTMLElement {
  scrolled?: boolean;
  scrollLocked: boolean;
  size: number; // current page height
  viewSize: number; // whole document view height
  start: number;
  end: number;
  page: number; // section page index (0-based)
  pages: number; // section page count
  atStart: boolean;
  atEnd: boolean;
  containerPosition: number;
  // Sub-pixel remainder of the scroll position, rendered as a transform on the
  // scrollport because scroll offsets themselves quantize to whole CSS pixels.
  subpixelOffset: number;
  scrollProp: 'scrollLeft' | 'scrollTop';
  sideProp: 'width' | 'height';
  pageColors?: {
    background: string;
    foreground: string;
  };
  columnCount?: number;
  open: (book: BookDoc) => Promise<void>;
  setAttribute: (name: string, value: string | number) => void;
  removeAttribute: (name: string) => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  nextSection?: () => Promise<void>;
  prevSection?: () => Promise<void>;
  render?: () => Promise<void>;
  goTo: (params: { index: number; anchor?: number | RangeAnchor }) => Promise<void>;
  setStyles?: (css: string) => void;
  primaryIndex: number;
  getContents: () => { doc: Document; index?: number; overlayer?: unknown }[];
  scrollToAnchor?: (anchor: number | Range, reason?: string, smooth?: boolean) => void;
  addEventListener: (
    type: string,
    listener: EventListener,
    option?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListener,
    option?: EventListenerOptions,
  ) => void;
  showLoupe?: (
    x: number,
    y: number,
    options: {
      isVertical: boolean;
      color: string;
      gap: number;
      margin: number;
      radius: number;
      magnification: number;
    },
  ) => void;
  hideLoupe?: () => void;
  destroyLoupe?: () => void;
  pinchZoom?: (ratio: number) => void;
  pinchEnd?: () => void;
  destroy: () => void;
}

export interface FoliateView extends HTMLElement {
  readonly hasUserNavigation?: boolean;
  getNavigationGeneration?: () => number | null;
  noteRendererNavigation?: (reason: string) => void;
  finishNavigation?: () => Promise<void>;
  open: (book: BookDoc) => Promise<void>;
  close: () => void;
  init: (options: { lastLocation: string }) => void;
  goTo: (target: string | number) => void;
  goToFraction: (fraction: number, options?: { initial?: boolean }) => void;
  getSectionFractions: () => number[];
  prev: (distance?: number) => void;
  next: (distance?: number) => void;
  pan: (dx: number, dy: number) => void;
  isOverflowX: () => boolean;
  isOverflowY: () => boolean;
  goLeft: () => void;
  goRight: () => void;
  getCFI: (index: number, range?: Range) => string;
  getCFIProgress: (cfi: string) => Promise<{
    fraction: number;
    section: { current: number; total: number };
    location: { current: number; next: number; total: number };
    time: { section: number; total: number };
  } | null>;
  resolveCFI: (cfi: string) => { index: number; anchor: RangeAnchor };
  resolveNavigation: (cfiOrHrefOrIndex: string | number) => { index: number; anchor?: RangeAnchor };
  addAnnotation: (
    note: BookNote & { value?: string },
    remove?: boolean,
  ) => { index: number; label: string };
  search: (config: BookSearchConfig) => AsyncGenerator<BookSearchResult | string, void, void>;
  clearSearch: () => void;
  select: (target: string | number | { fraction: number }) => void;
  deselect: () => void;
  initTTS: (
    granularity?: TTSGranularity,
    nodeFilter?: (node: Node) => number,
    highlight?: (range: Range) => void,
  ) => Promise<void>;
  book: BookDoc;
  tts: ViewTTS | null;
  // The most recent relocate location, set synchronously by foliate on every
  // relocate — fresher than the rAF-debounced readerStore progress.
  lastLocation?: { cfi?: string; range?: Range | null };
  isFixedLayout: boolean;
  language: {
    locale?: LocaleWithTextInfo;
    isCJK?: boolean;
    canonical?: string;
    direction?: string;
  };
  history: {
    canGoBack: boolean;
    canGoForward: boolean;
    back: () => void;
    forward: () => void;
    clear: () => void;
  };
  renderer: Renderer;
}

export const wrappedFoliateView = (
  originalView: FoliateView,
  announceNavigation?: (generation: number) => void,
): FoliateView => {
  let initialization: Promise<void> | undefined;
  let initializing = false;
  let hasUserNavigation = false;
  let requestedGeneration = 1;
  let renderedGeneration = 1;
  let navigating = false;
  let finishing = false;
  Object.defineProperty(originalView, 'hasUserNavigation', { get: () => hasUserNavigation });
  const readingAction = () => {
    hasUserNavigation = true;
    announceNavigation?.(++requestedGeneration);
    originalView.dispatchEvent(new Event('reading-action'));
    return requestedGeneration;
  };
  let navigation: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  const canceled = new Promise<void>((resolve) =>
    lifetime.signal.addEventListener('abort', () => resolve(), { once: true }),
  );
  // One renderer must finish loading a document before the next operation can
  // replace it. Recover the queue after errors, while returning each caller's
  // own completion (or close cancellation).
  const enqueue = (action: () => void | Promise<void>, generation: number) => {
    const pending = navigation.then(async () => {
      if (lifetime.signal.aborted) return;
      renderedGeneration = generation;
      navigating = true;
      originalView.dispatchEvent(new Event('reading-action'));
      try {
        await action();
      } finally {
        navigating = false;
      }
    });
    navigation = pending.catch(() => undefined);
    return Promise.race([pending, canceled]);
  };
  originalView.getNavigationGeneration = () =>
    renderedGeneration === requestedGeneration && renderedGeneration > 1 && !lifetime.signal.aborted
      ? renderedGeneration
      : null;
  originalView.noteRendererNavigation = (reason) => {
    if (
      announceNavigation &&
      !navigating &&
      !initialization &&
      !finishing &&
      renderedGeneration === requestedGeneration &&
      (reason === 'scroll' || reason === 'snap' || reason === 'page')
    )
      renderedGeneration = readingAction();
  };
  originalView.finishNavigation = async () => {
    finishing = true;
    await Promise.race([navigation, canceled]);
  };
  if (announceNavigation) {
    const open = originalView.open.bind(originalView);
    originalView.open = async (book) => {
      await open(book);
      const renderer = originalView.renderer;
      for (const method of ['nextSection', 'prevSection'] as const) {
        const step = renderer[method]?.bind(renderer);
        if (!step) continue;
        renderer[method] = async () => {
          if (!finishing) await enqueue(step, readingAction());
        };
      }
    };
  }
  const close = originalView.close.bind(originalView);
  originalView.close = () => {
    lifetime.abort();
    originalView.dispatchEvent(new Event('reading-close'));
    close();
  };
  const initialize = originalView.init.bind(originalView);
  originalView.init = (options) => {
    let pending: Promise<void>;
    initializing = true;
    try {
      pending = Promise.resolve(initialize(options));
    } finally {
      initializing = false;
    }
    initialization = pending;
    navigation = pending.catch(() => undefined);
    return pending.finally(() => {
      if (initialization === pending) initialization = undefined;
    });
  };
  // Notify pending cold restoration before a turn's animation starts. Waiting
  // for relocate would let a font completion reapply the old location mid-turn.
  for (const method of ['next', 'prev'] as const) {
    const navigate = originalView[method].bind(originalView);
    originalView[method] = (distance?: number) => {
      if (initializing) return navigate(distance);
      if (finishing) return;
      return enqueue(() => navigate(distance), readingAction());
    };
  }
  const goToFraction = originalView.goToFraction.bind(originalView);
  originalView.goToFraction = (fraction, options) => {
    if (finishing) return;
    return enqueue(() => goToFraction(fraction), options?.initial ? 1 : readingAction());
  };
  for (const method of ['back', 'forward'] as const) {
    const navigate = originalView.history[method].bind(originalView.history);
    originalView.history[method] = () => {
      if (finishing) return;
      if (!announceNavigation) {
        readingAction();
        return navigate();
      }
      return enqueue(() => {
        // Foliate dispatches popstate synchronously but History's API discards
        // renderer.goTo's promise. Keep the same queue ownership until it settles.
        const renderer = originalView.renderer;
        const goTo = renderer.goTo;
        let pending: Promise<void> | undefined;
        renderer.goTo = (target) => (pending = goTo.call(renderer, target));
        try {
          navigate();
          return pending;
        } finally {
          renderer.goTo = goTo;
        }
      }, readingAction());
    };
  }
  const originalAddAnnotation = originalView.addAnnotation.bind(originalView);
  originalView.addAnnotation = (note: BookNote, remove = false) => {
    // transform BookNote to foliate annotation
    const annotation = {
      value: note.cfi,
      ...note,
    };
    return originalAddAnnotation(annotation, remove);
  };

  const originalGoTo = originalView.goTo.bind(originalView);
  // The FoliateView interface declares goTo as (href: string) => void, but
  // Foliate's runtime implementation returns a Promise. Returning a Promise
  // here is compatible with the void return type in TypeScript and lets callers
  // that know about the promise (e.g. tests, async handlers) await completion.
  originalView.goTo = (target: string | number): Promise<void> => {
    if (finishing) return Promise.resolve();
    // Cross-section jumps can take seconds (the target section's images block
    // its iframe load); surface start/end so the viewer can show a spinner.
    const accepted = originalView.dispatchEvent(
      new CustomEvent('navigate-start', { detail: { target }, cancelable: true }),
    );
    // Recreating the same iframe before its load resolves strands init. A
    // repeated host restore is canceled by the pending initial-location owner;
    // a new jump waits for that first document before taking over.
    const pending = accepted ? enqueue(() => originalGoTo(target), readingAction()) : undefined;
    return Promise.resolve(pending).finally(() => {
      originalView.dispatchEvent(new CustomEvent('navigate-end'));
    });
  };

  return originalView;
};
