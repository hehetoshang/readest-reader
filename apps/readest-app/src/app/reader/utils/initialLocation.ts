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
  // Cancel before foliate forwards a user relocate to Reader's progress writer.
  renderer.addEventListener('relocate', onRelocate, { capture: true });
  signal.addEventListener(
    'abort',
    () => {
      view.removeEventListener('navigate-start', onNavigate);
      view.removeEventListener('reading-action', cancel);
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
      await Promise.race([stylesheetLoads.get(doc), aborted]);
      if (signal.aborted) return;
      // Force style resolution before obtaining the *new* font-ready promise.
      doc.documentElement.getBoundingClientRect();
      const { fontsReady } = await import('foliate-js/paginator.js');
      await Promise.race([fontsReady(doc), aborted]);
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
      cancel();
      await renderer.scrollToAnchor?.(anchor);
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener('abort', onAbort!);
      cancel();
    }
  };
  return { signal, cancel, complete };
};
