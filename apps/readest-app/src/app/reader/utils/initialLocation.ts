import type { FoliateView } from '@/types/view';

// fonts.ready can resolve before Reader's injected font stylesheets arrive.
// A later fallback -> webfont swap can move a Range to another column without
// changing the body's size, so paginator's ResizeObserver cannot finish the
// restore. Keep the requested location through that first font/layout cycle.
export const preserveInitialLocation = (
  view: FoliateView,
  location: string,
  stylesheetLoads: WeakMap<Document, Promise<void>>,
) => {
  const controller = new AbortController();
  const { signal } = controller;
  const { renderer } = view;
  const target = view.resolveNavigation(location);
  let positioning = false;
  const cancel = () => controller.abort();
  const onNavigate = (event: Event) => {
    // Moke can repeat the initial restore after book:opened. It is the same
    // intent; a different explicit jump immediately takes ownership instead.
    if ((event as CustomEvent<{ target?: unknown }>).detail?.target === location) {
      event.preventDefault();
    } else cancel();
  };
  const onRelocate = (event: Event) => {
    const { reason } = (event as CustomEvent<{ reason?: string }>).detail;
    if (reason !== 'anchor' && reason !== 'navigation' && reason !== 'container-scroll') cancel();
  };
  view.addEventListener('navigate-start', onNavigate);
  view.addEventListener('reading-action', cancel);
  view.addEventListener('reading-close', cancel);
  // Cancel before foliate forwards a user relocate to Reader's progress writer.
  renderer.addEventListener('relocate', onRelocate, { capture: true });
  signal.addEventListener(
    'abort',
    () => {
      view.removeEventListener('navigate-start', onNavigate);
      view.removeEventListener('reading-action', cancel);
      view.removeEventListener('reading-close', cancel);
      renderer.removeEventListener('relocate', onRelocate, { capture: true });
    },
    { once: true },
  );

  const complete = async () => {
    const doc = renderer.getContents().find(({ index }) => index === target?.index)?.doc;
    if (!doc || !target?.anchor || signal.aborted) return cancel();
    let onAbort: () => void;
    let frame: number | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
    });
    signal.addEventListener('abort', onAbort!, { once: true });
    try {
      // Earlier retained sections contribute to the target's scroll offset.
      // Waiting only for the target's fonts still permits a preceding section
      // to shrink later and move the same Range out of the viewport.
      const documents = renderer.getContents().map((content) => content.doc);
      await Promise.race([
        Promise.all(documents.map((document) => stylesheetLoads.get(document))),
        aborted,
      ]);
      if (signal.aborted) return;
      // Force style resolution before obtaining the *new* font-ready promise.
      for (const document of documents) document.documentElement.getBoundingClientRect();
      const { fontsReady } = await import('foliate-js/paginator.js');
      await Promise.race([Promise.all(documents.map((document) => fontsReady(document))), aborted]);
      if (signal.aborted) return;
      // Let the font layout and its ResizeObserver callbacks finish this frame.
      await Promise.race([
        new Promise<void>((resolve) => {
          frame = requestAnimationFrame(() => resolve());
        }),
        aborted,
      ]);
      if (
        signal.aborted ||
        !view.isConnected ||
        view.renderer !== renderer ||
        !renderer.getContents().some((content) => content.doc === doc) ||
        renderer.primaryIndex !== target.index
      )
        return;
      const anchor = target.anchor(doc);
      positioning = true;
      cancel();
      await renderer.scrollToAnchor?.(anchor);
    } finally {
      positioning = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener('abort', onAbort!);
      cancel();
    }
  };
  return {
    signal,
    cancel,
    complete,
    get positioning() {
      return positioning;
    },
  };
};

// Every explicit relocation can become the new font/layout owner, including
// page turns made while a different chapter's stylesheet is still loading.
// Keep the real Range intent; passive resize/container-scroll reports must not
// replace it or leak a provisional page into the persistent progress store.
export const preserveReadingContext = (
  view: FoliateView,
  stylesheetLoads: WeakMap<Document, Promise<void>>,
  isRestoring: () => boolean = () => false,
) => {
  const lifetime = new AbortController();
  let pending: ReturnType<typeof preserveInitialLocation> | undefined;
  let provisional = false;
  const renderer = view.renderer;
  const relocate = (event: Event) => {
    if (pending?.positioning || isRestoring()) {
      provisional = false;
      return;
    }
    const { reason, range, index } = (
      event as CustomEvent<{
        reason: string;
        range: Range;
        index: number;
      }>
    ).detail;
    const passive = reason === 'anchor' || reason === 'container-scroll';
    provisional = passive && !!pending && !pending.signal.aborted;
    if (passive || !range || view.isFixedLayout) return;
    pending?.cancel();
    const owner = preserveInitialLocation(view, view.getCFI(index, range), stylesheetLoads);
    pending = owner;
    void owner.complete().catch((error) => {
      console.warn('Unable to finish reading context layout', error);
    });
  };
  renderer.addEventListener('relocate', relocate, { capture: true });
  const cancel = () => {
    lifetime.abort();
    pending?.cancel();
    renderer.removeEventListener('relocate', relocate, { capture: true });
    view.removeEventListener('reading-close', cancel);
  };
  view.addEventListener('reading-close', cancel);
  return {
    signal: lifetime.signal,
    cancel,
    get provisional() {
      return provisional;
    },
  };
};
